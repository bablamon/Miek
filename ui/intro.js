// Miek logo: injected inline (so strokes can be animated) + the opening animation.
// The intro draws the hand-drawn logo line by line, then the logo beats on a short
// drum groove synthesized with Web Audio (no audio files, nothing licensed).

const LOGO = { svg: null };

async function loadLogo() {
  if (!LOGO.svg) LOGO.svg = await fetch('miek-logo.svg').then((r) => r.text());
  let n = 0;
  document.querySelectorAll('.logo-slot').forEach((slot) => {
    if (slot.firstElementChild) return;
    // ids inside the SVG (mask, <use> target) must be unique per copy
    const k = `l${n++}_`;
    slot.innerHTML = LOGO.svg.replace(/id="([^"]+)"/g, `id="${k}$1"`).replace(/#(stroke[0-9_]+)/g, `#${k}$1`);
    const svg = slot.querySelector('svg');
    svg.removeAttribute('width');
    svg.removeAttribute('height');
    svg.setAttribute('aria-hidden', 'true');
  });
}

const introPrefs = {
  get sound() { try { return localStorage.getItem('miek.introSound') !== 'off'; } catch { return true; } },
  set sound(v) { try { localStorage.setItem('miek.introSound', v ? 'on' : 'off'); } catch {} },
};

// ---- drum voices -----------------------------------------------------------
function kick(ctx, out, t) {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = 'sine';
  o.frequency.setValueAtTime(150, t);
  o.frequency.exponentialRampToValueAtTime(42, t + 0.14);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(1, t + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
  o.connect(g).connect(out);
  o.start(t);
  o.stop(t + 0.45);
}
function noiseBuffer(ctx) {
  const b = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return b;
}
function snare(ctx, out, t, buf) {
  const n = ctx.createBufferSource();
  n.buffer = buf;
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.value = 1900;
  f.Q.value = 0.7;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.45, t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
  n.connect(f).connect(g).connect(out);
  n.start(t);
  n.stop(t + 0.22);
  const body = ctx.createOscillator();
  const bg = ctx.createGain();
  body.frequency.setValueAtTime(220, t);
  body.frequency.exponentialRampToValueAtTime(140, t + 0.08);
  bg.gain.setValueAtTime(0.25, t);
  bg.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
  body.connect(bg).connect(out);
  body.start(t);
  body.stop(t + 0.13);
}
function hat(ctx, out, t, buf) {
  const n = ctx.createBufferSource();
  n.buffer = buf;
  const f = ctx.createBiquadFilter();
  f.type = 'highpass';
  f.frequency.value = 7500;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.16, t + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
  n.connect(f).connect(g).connect(out);
  n.start(t);
  n.stop(t + 0.06);
}

// ---- the intro ---------------------------------------------------------------
function playIntro() {
  return new Promise(async (resolve) => {
    const intro = document.getElementById('intro');
    const logo = intro.querySelector('.intro-logo');
    const ring = intro.querySelector('.intro-ring');
    await loadLogo();
    const svg = logo.querySelector('svg');
    intro.classList.remove('hidden');

    const timers = [];
    let ctx = null;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      timers.forEach(clearTimeout);
      intro.classList.add('leaving');
      if (ctx) setTimeout(() => ctx.close().catch(() => {}), 600);
      setTimeout(() => { intro.classList.add('hidden'); intro.classList.remove('leaving'); resolve(); }, 520);
    };
    intro.onclick = finish;
    const onKey = (e) => { if (e.key === 'Escape' || e.key === 'Enter' || e.code === 'Space') { removeEventListener('keydown', onKey); finish(); } };
    addEventListener('keydown', onKey);

    // 1. pen sketch: every line draws in, staggered along the drawing
    const lines = [...svg.querySelectorAll('path[stroke="white"]')];
    lines.forEach((p, i) => {
      p.setAttribute('pathLength', '1');
      p.style.strokeDasharray = '1';
      p.style.strokeDashoffset = '1';
      p.animate([{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration: 900, delay: 80 + i * 45, easing: 'cubic-bezier(.65,0,.25,1)', fill: 'forwards' });
    });
    const letters = [...svg.querySelectorAll('use, path[mask]')];
    letters.forEach((el) => { el.style.opacity = '0'; el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 350, delay: 900, fill: 'forwards' }); });
    intro.querySelector('.intro-word').animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 500, delay: 1000, fill: 'forwards', easing: 'ease-out' });

    // 2. beat: 2 bars at 112 BPM, logo pulses on every kick, snare on 2 & 4, eighth-note hats
    const bpm = 112;
    const beat = 60 / bpm;
    const start = 1.35; // seconds after now, once the sketch is drawn
    const pattern = [
      // [beat position, voice]
      [0, 'k'], [1, 's'], [1.5, 'k'], [2, 'k'], [3, 's'],
      [4, 'k'], [5, 's'], [5.5, 'k'], [6, 'k'], [6.75, 'k'], [7, 's'],
    ];
    if (introPrefs.sound) {
      try {
        ctx = new AudioContext();
        const master = ctx.createGain();
        master.gain.value = 0.55;
        const comp = ctx.createDynamicsCompressor();
        master.connect(comp).connect(ctx.destination);
        const buf = noiseBuffer(ctx);
        const t0 = ctx.currentTime + start;
        for (const [pos, v] of pattern) (v === 'k' ? kick : (c, o, t) => snare(c, o, t, buf))(ctx, master, t0 + pos * beat);
        for (let i = 0; i < 16; i++) hat(ctx, master, t0 + i * beat * 0.5, buf);
      } catch { ctx = null; }
    }
    for (const [pos, v] of pattern) {
      timers.push(setTimeout(() => {
        const big = v === 'k';
        logo.animate(
          [{ transform: 'scale(1)' }, { transform: `scale(${big ? 1.1 : 1.04})`, offset: 0.18 }, { transform: 'scale(1)' }],
          { duration: big ? 380 : 260, easing: 'cubic-bezier(.2,.8,.2,1)' });
        if (big) ring.animate([{ transform: 'scale(.55)', opacity: 0.55 }, { transform: 'scale(1.5)', opacity: 0 }], { duration: 700, easing: 'cubic-bezier(.1,.7,.3,1)' });
      }, (start + pos * beat) * 1000));
    }
    timers.push(setTimeout(finish, (start + 8 * beat) * 1000 + 250));
  });
}
