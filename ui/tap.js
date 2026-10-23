// Tap sounds: a short, soft, stony tick when you press a button, like Pixel's touch sounds. Made with
// Web Audio (no sound file): a 30 ms burst of noise through a band-pass filter around 2.5 kHz for the
// tick, and a tiny sine "knock" falling from ~420 to ~180 Hz for body. Pitch varies a little each
// time so it never sounds mechanical. Fixed, quiet level, independent of the music volume.
// On by default; Settings → Sounds turns it off.
// Loaded after app.js; uses its globals (h, $).

const TAP = { ctx: null, noise: null, count: 0, last: 0 };
const TAP_KEY = 'miek.tapSounds';
function tapOn() {
  try { return localStorage.getItem(TAP_KEY) !== 'off'; } catch { return true; }
}

// one tap into any AudioContext (also an OfflineAudioContext, for testing)
function tapInto(ctx, at = ctx.currentTime, level = 1) {
  if (!TAP.noise || TAP.noise.sampleRate !== ctx.sampleRate) {
    const len = Math.floor(ctx.sampleRate * 0.03);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 4);
    TAP.noise = buf;
  }
  const vary = 0.92 + Math.random() * 0.16;
  // the tick
  const src = ctx.createBufferSource();
  src.buffer = TAP.noise;
  const band = ctx.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.value = 2500 * vary;
  band.Q.value = 1.3;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.22 * level, at);
  g.gain.exponentialRampToValueAtTime(0.0005, at + 0.05);
  src.connect(band).connect(g).connect(ctx.destination);
  src.start(at);
  // the knock
  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(420 * vary, at);
  o.frequency.exponentialRampToValueAtTime(180 * vary, at + 0.04);
  const og = ctx.createGain();
  og.gain.setValueAtTime(0.0001, at);
  og.gain.exponentialRampToValueAtTime(0.14 * level, at + 0.003);
  og.gain.exponentialRampToValueAtTime(0.0005, at + 0.06);
  o.connect(og).connect(ctx.destination);
  o.start(at);
  o.stop(at + 0.07);
}

function tap() {
  if (!tapOn()) return;
  const now = performance.now();
  if (now - TAP.last < 35) return; // a double fire (pointer + key) is one tap
  TAP.last = now;
  try {
    TAP.ctx ||= new AudioContext();
    if (TAP.ctx.state === 'suspended') TAP.ctx.resume();
    tapInto(TAP.ctx);
    TAP.count++;
  } catch {}
}

// what counts as pressing something: buttons, menu items, chips, the sidebar, play on a row
const TAPPABLE = 'button:not(:disabled), .mi, .nav, .chip, .t-idx, .card, .pl-item, a.lnk';
addEventListener('pointerdown', (e) => {
  if (e.button === 0 && e.target.closest && e.target.closest(TAPPABLE)) tap();
}, true);
addEventListener('keydown', (e) => {
  // Space for play/pause, Enter on a focused button
  if ((e.code === 'Space' && e.target.tagName !== 'INPUT') || (e.key === 'Enter' && e.target.closest && e.target.closest('button'))) tap();
}, true);

function tapSettings() {
  const btn = h('button', { class: 'btn' }, tapOn() ? 'On' : 'Off');
  btn.onclick = () => {
    try { localStorage.setItem(TAP_KEY, tapOn() ? 'off' : 'on'); } catch {}
    btn.textContent = tapOn() ? 'On' : 'Off';
  };
  return h('div', { class: 'panel' },
    h('div', { class: 'setting' }, h('div', {}, h('div', { class: 'label', text: 'Tap sounds' }), h('div', { class: 'fine', text: 'A soft tap when you press buttons.' })), btn));
}
