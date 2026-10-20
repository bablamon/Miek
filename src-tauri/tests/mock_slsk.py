"""Mock Soulseek server + peer for testing Miek's client without the real network.

    python -I tests/mock_slsk.py <audio file> [direct|relay]

Server on 127.0.0.1:22420. Peer "alice" shares <audio file> under two names (one Latin-1 encoded)
plus "denied.flac" (always refused) and "cover.jpg" (not audio). "bob" is offline.
direct: alice is reachable and opens her "F" connection straight to the client.
relay:  alice is "firewalled": the client has to go through ConnectToPeer / PierceFireWall both ways.
alice drops the first upload of each file at 40 % to exercise resuming, and sends at ~600 KB/s so
playback starts while the file is still arriving.
"""
import os, socket, struct, sys, threading, time, zlib

AUDIO = sys.argv[1]
MODE = sys.argv[2] if len(sys.argv) > 2 else "direct"
DATA = open(AUDIO, "rb").read()
FILES = {
    b"Music\\Alice\\Tones\\01 - Test Tone.flac": DATA,
    "Música\\Tones\\Café tone.flac".encode("latin-1"): DATA,
    # what Autoplay finds when it searches for the artist ("Test Artist")
    b"Music\\Test Artist\\Songs\\02 - Song Two.flac": DATA,
    b"Music\\Test Artist\\Songs\\03 - Song Three.flac": DATA,
    b"Music\\Test Artist\\Songs\\01 - Test Tone.flac": DATA,
}
DENIED = b"Music\\Alice\\denied.flac"
RATE = 600 * 1024
log = lambda *a: print("[mock]", *a, flush=True)

def s(b):  # string
    if isinstance(b, str): b = b.encode()
    return struct.pack("<I", len(b)) + b
def msg(code, payload=b""): return struct.pack("<II", 4 + len(payload), code) + payload
def init(code, payload=b""): return struct.pack("<IB", 1 + len(payload), code) + payload

def frames(c):
    buf = b""
    while True:
        while len(buf) >= 4 and len(buf) >= 4 + struct.unpack("<I", buf[:4])[0]:
            n = struct.unpack("<I", buf[:4])[0]
            yield buf[4:4 + n]
            buf = buf[4 + n:]
        d = c.recv(65536)
        if not d: return
        buf += d

class Rd:
    def __init__(s, b): s.b, s.p = b, 0
    def take(s, n): v = s.b[s.p:s.p + n]; s.p += n; return v
    def u32(s): return struct.unpack("<I", s.take(4))[0]
    def u64(s): return struct.unpack("<Q", s.take(8))[0]
    def u8(s): return s.take(1)[0]
    def raw(s): return s.take(s.u32())

client = {"conn": None, "port": None, "lock": threading.Lock()}
dropped = set()

def to_client(b):
    with client["lock"]: client["conn"].sendall(b)

def connect_client():
    c = socket.create_connection(("127.0.0.1", client["port"]), timeout=10)
    c.settimeout(None)  # the 10 s is for connecting; an idle peer connection must stay open
    return c

# ------------------------------------------------------------------ alice
ALICE_ITEMS = [(f, len(d), [(1, 30), (4, 48000), (5, 24)]) for f, d in FILES.items() if b"Test Artist" not in f]
ALICE_ITEMS += [(DENIED, 1234567, [(1, 30), (4, 44100), (5, 16)]), (b"Music\\Alice\\Tones\\cover.jpg", 2048, [])]
# carol answers first, with lossy files only (FLAC results must still be listed ahead of them)
CAROL_ITEMS = [(b"Share\\Tones\\Test Tone.m4a", 3000000, [(0, 256), (1, 30)]), (b"Share\\Tones\\Test Tone.mp3", 1200000, [(0, 320), (1, 30), (2, 0)])]

def search_response(token, user="alice", items=ALICE_ITEMS):
    res = b""
    for f, size, attrs in items:
        res += b"\x01" + s(f) + struct.pack("<Q", size) + s(b"") + struct.pack("<I", len(attrs))
        res += b"".join(struct.pack("<II", c, v) for c, v in attrs)
    body = s(user) + struct.pack("<I", token) + struct.pack("<I", len(items)) + res
    body += b"\x01" + struct.pack("<III", 123456, 0, 0) + struct.pack("<I", 0)
    return msg(9, zlib.compress(body))

pending = {}  # transfer token -> filename

def serve_f(c, token):
    c.sendall(struct.pack("<I", token))
    off = b""
    while len(off) < 8:
        d = c.recv(8 - len(off))
        if not d: return log("F closed before offset")
        off += d
    offset = struct.unpack("<Q", off)[0]
    fname, p = pending[token]
    data = FILES[fname]
    log(f"F upload {fname!r} from offset {offset} of {len(data)}")
    drop_at = None if fname in dropped else int(len(data) * 0.4)
    pos, t0 = offset, time.time()
    try:
        while pos < len(data):
            if drop_at is not None and pos >= drop_at:
                dropped.add(fname)
                log(f"dropping upload at {pos}")
                c.close()
                p.sendall(msg(46, s(fname)))  # UploadFailed
                return
            n = min(16384, len(data) - pos)
            c.sendall(data[pos:pos + n])
            pos += n
            ahead = (pos - offset) / RATE - (time.time() - t0)
            if ahead > 0: time.sleep(ahead)
        log("F upload complete; waiting for client to close")
        c.settimeout(10)
        c.recv(1)
    except OSError as e:
        log(f"F connection ended at {pos}: {e}")

def start_f(token):
    if MODE == "direct":
        c = connect_client()
        c.sendall(init(1, s("alice") + s("F") + struct.pack("<I", 0)))
        serve_f(c, token)
    else:
        # firewalled: ask the client (via the server) to connect to us and pierce
        ls = socket.socket(); ls.bind(("127.0.0.1", 0)); ls.listen(1)
        ctoken = 900000 + token
        to_client(msg(18, s("alice") + s("F") + struct.pack("<III", 0x7F000001, ls.getsockname()[1], ctoken) + b"\x00"))
        ls.settimeout(10)
        c, _ = ls.accept()
        f = frames(c); first = next(f)
        assert first[0] == 0 and struct.unpack("<I", first[1:5])[0] == ctoken, first
        log("client pierced F")
        serve_f(c, token)

def alice_listener(ls):
    while True:
        c, _ = ls.accept()
        def h(c=c):
            f = frames(c); first = next(f)
            r = Rd(first[1:])
            log(f"alice: incoming init {first[0]} from {r.raw()!r} type {r.raw()!r}")
            peer_loop_from(c, f)
        threading.Thread(target=h, daemon=True).start()

def peer_loop_from(c, gen):
    # continue a frame generator that already consumed the init message
    for f in gen:
        handle_peer(c, f, [700])

def handle_peer(c, f, next_token):
    code = struct.unpack("<I", f[:4])[0]; r = Rd(f[4:])
    if code == 43:
        fname = r.raw()
        log(f"QueueUpload {fname!r}")
        if fname == DENIED or fname not in FILES:
            c.sendall(msg(50, s(fname) + s("Too many files" if fname == DENIED else "File not shared.")))
            return
        c.sendall(msg(44, s(fname) + struct.pack("<I", 3)))
        def later(fname=fname):
            time.sleep(1.5)
            next_token[0] += 1
            t = next_token[0] + int(time.time() * 1000) % 100000
            pending[t] = (fname, c)
            c.sendall(msg(40, struct.pack("<II", 1, t) + s(fname) + struct.pack("<Q", len(FILES[fname]))))
        threading.Thread(target=later, daemon=True).start()
    elif code == 51:
        fname = r.raw()
        if fname in FILES: c.sendall(msg(44, s(fname) + struct.pack("<I", 3)))
    elif code == 41:
        token = r.u32(); ok = r.u8()
        log(f"TransferResponse token={token} allowed={ok}")
        if ok: threading.Thread(target=start_f, args=(token,), daemon=True).start()

def alice_pierce_p(ctoken):
    """relay mode: the client asked (via ConnectToPeer) for alice to connect to it."""
    c = connect_client()
    c.sendall(init(0, struct.pack("<I", ctoken)))
    log("alice pierced client for P")
    threading.Thread(target=lambda: [handle_peer(c, f, [700]) for f in frames(c)], daemon=True).start()

SONG = [(1, 200), (4, 48000), (5, 24)]
ARTIST_ALICE = [(f, len(FILES[f]), SONG) for f in FILES if b"Test Artist" in f]
ARTIST_ALICE.append((b"Music\\Test Artist\\Songs\\Intro.flac", 900000, [(1, 20), (4, 48000), (5, 24)]))  # too short for a song
# carol (unreachable): an MP3 copy of a song alice has in FLAC, and a song only she has
ARTIST_CAROL = [(b"Share\\Test Artist - Song Two.mp3", 8000000, [(0, 320), (1, 200)]), (b"Share\\Test Artist - Song Four.mp3", 8000000, [(0, 320), (1, 200)])]

def alice_search(token, query=b""):
    artist = b"test artist" in query.lower()
    early = connect_client()
    early.sendall(init(1, s("carol") + s("P") + struct.pack("<I", 0)))
    early.sendall(search_response(token, "carol", ARTIST_CAROL if artist else CAROL_ITEMS))
    time.sleep(1.0)
    c = connect_client()
    c.sendall(init(1, s("alice") + s("P") + struct.pack("<I", 0)))
    c.sendall(search_response(token, "alice", ARTIST_ALICE) if artist else search_response(token))
    log(f"alice answered search {token}")
    if MODE == "relay":
        time.sleep(0.3)
        return c.close()  # so the client has to open its own P connection, through the server
    threading.Thread(target=lambda: [handle_peer(c, f, [700]) for f in frames(c)], daemon=True).start()

# ------------------------------------------------------------------ server
def server():
    ls = socket.socket(); ls.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    ls.bind(("127.0.0.1", 22420)); ls.listen(4)
    alice_ls = socket.socket(); alice_ls.bind(("127.0.0.1", 0)); alice_ls.listen(8)
    threading.Thread(target=alice_listener, args=(alice_ls,), daemon=True).start()
    alice_port = alice_ls.getsockname()[1] if MODE == "direct" else 1  # port 1: nothing listens
    log(f"server ready ({MODE}); alice port {alice_port}")
    while True:
        c, _ = ls.accept()
        client["conn"] = c
        for f in frames(c):
            code = struct.unpack("<I", f[:4])[0]; r = Rd(f[4:])
            if code == 1:
                user, pw, ver = r.raw(), r.raw(), r.u32()
                log(f"login {user!r} version {ver}")
                to_client(msg(1, b"\x01" + s("welcome") + struct.pack("<I", 0x7F000001) + s("x") + b"\x00"))
            elif code == 2:
                client["port"] = r.u32(); log(f"client port {client['port']}")
            elif code == 3:
                user = r.raw()
                ip, port = (0x7F000001, alice_port) if user == b"alice" else (0, 0)
                to_client(msg(3, s(user) + struct.pack("<III", ip, port, 0) + struct.pack("<H", 0)))
            elif code == 26:
                token = r.u32(); q = r.raw(); log(f"search {token} {q!r}")
                threading.Thread(target=alice_search, args=(token, q), daemon=True).start()
            elif code == 18:
                token = r.u32(); user = r.raw(); kind = r.raw()
                log(f"client ConnectToPeer {user!r} {kind!r} token {token}")
                if user == b"alice" and kind == b"P":
                    threading.Thread(target=alice_pierce_p, args=(token,), daemon=True).start()
        log("client disconnected")

server()
