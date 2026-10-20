/* audio.js — every sound in the world, synthesised with Web Audio (no files): a diesel engine
   that follows the truck, one-shot SFX for the world and the missions, a procedural steppe
   theme (morin-khuur drone, a composed 16-bar A-minor-pentatonic melody with ornaments, a
   frame drum) on a lookahead scheduler, and a mute chip that agrees with the M key.
   Replaces the W.audio stub from core.js. Everything goes through W; see CONTRACT.md. */
(() => {
  const W = window.W; if (!W) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  const LS = 'khuslen.world.muted';
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const mtof = m => 440 * Math.pow(2, (m - 69) / 12);
  // Audio-local deterministic randomness: world placement keeps W.rng to itself.
  let seed = 7919; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const hash = (a, b) => { let h = (a * 374761393 + b * 668265263) | 0; h = Math.imul(h ^ h >>> 13, 1274126177); return ((h ^ h >>> 16) >>> 0) / 4294967296; };

  /* ---------------- the public object ---------------- */
  const A = W.audio = {
    ready: false, muted: false, init, sfx, engine, music, setMuted,
    debug: { notesScheduled: 0, sfxPlayed: 0, dropped: 0, voices: 0, step: 0, loop: 0, state: 'none', engine: null, render: null }
  };
  try { A.muted = localStorage.getItem(LS) === '1'; } catch (e) { }

  /* ---------------- the score ---------------- */
  const BPM = 96, EIGHTH = 60 / BPM / 2, STEPS = 128, LOOK = .4;            // 16 bars of 4/4 = 40 s loop; .4 s lookahead rides out slow frames
  const SCALE = [57, 60, 62, 64, 67, 69, 72, 74, 76, 79, 81];              // A minor pentatonic, A3..A5 (MIDI)
  // [step in eighths, MIDI note, length in eighths]. Four phrases of four bars: a rising call,
  // the same call answered higher, the high "long song" cry, and a descent home to A.
  const MELODY = [
    [0, 64, 3], [3, 67, 1], [4, 69, 4], [8, 72, 2], [10, 69, 2], [12, 67, 3], [15, 64, 1],
    [16, 62, 3], [19, 64, 1], [20, 67, 2], [22, 64, 2], [24, 62, 2], [26, 60, 2], [28, 57, 4],
    [32, 64, 3], [35, 67, 1], [36, 69, 4], [40, 72, 2], [42, 74, 2], [44, 76, 4],
    [48, 74, 3], [51, 72, 1], [52, 69, 2], [54, 67, 2], [56, 69, 6],
    [64, 69, 1], [65, 72, 1], [66, 76, 4], [70, 79, 2], [72, 81, 4], [76, 79, 2], [78, 76, 2],
    [80, 74, 3], [83, 76, 1], [84, 72, 2], [86, 69, 2], [88, 67, 2], [90, 69, 2], [92, 64, 4],
    [96, 62, 2], [98, 64, 2], [100, 67, 3], [103, 69, 1], [104, 72, 2], [106, 69, 2], [108, 67, 2], [110, 64, 2],
    [112, 62, 3], [115, 60, 1], [116, 62, 2], [118, 64, 2], [120, 57, 5]
  ];
  const BY_STEP = []; for (const n of MELODY) (BY_STEP[n[0]] = BY_STEP[n[0]] || []).push(n);
  const BASS_BARS = new Set([4, 5, 6, 7, 12, 13, 14, 15]);                 // bars where a low voice doubles the melody

  /* ---------------- one synth per AudioContext (the live one, or an offline one for tests) ---------------- */
  function makeSynth(ctx, stats) {
    stats = stats || { notesScheduled: 0, sfxPlayed: 0, dropped: 0, voices: 0 };
    const now = () => ctx.currentTime;

    // master → gentle compressor → speakers; three buses so levels stay predictable
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -14; comp.knee.value = 18; comp.ratio.value = 3.5; comp.attack.value = .004; comp.release.value = .2;
    const trim = ctx.createGain(); trim.gain.value = .8; comp.connect(trim); trim.connect(ctx.destination); // 2 dB of headroom: a crash on top of engine and music must not clip
    const master = ctx.createGain(); master.gain.value = 1; master.connect(comp);
    const gn = (v, dest) => { const g = ctx.createGain(); g.gain.value = v; if (dest) g.connect(dest); return g; };
    const filt = (type, f, q, dest) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; if (q != null) b.Q.value = q; if (dest) b.connect(dest); return b; };
    const sfxBus = gn(.85, master), musicBus = gn(.12, master), engineBus = gn(.42, master);
    // a cheap echo for the open-steppe feel (horns, chimes)
    const echoIn = gn(1, null), delay = ctx.createDelay(1); delay.delayTime.value = .27; const echoLP = filt('lowpass', 1900, .7, null), fb = gn(.32, delay);
    echoIn.connect(delay); delay.connect(echoLP); echoLP.connect(fb); echoLP.connect(gn(.5, master));
    // two seconds of white noise, shared by every hiss, thud and drum
    const noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    { const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = rnd() * 2 - 1; }

    /* ----- voices: a gain per sound that is disconnected when its last source ends ----- */
    let active = []; const MAX_SFX = 16;
    const prune = t => { if (active.length) active = active.filter(v => v.end > t); stats.voices = active.length; };
    function voice(t0, { bus = sfxBus, gain = 1, echo = 0, imp = false } = {}) {
      prune(now());
      if (!imp) { let n = 0; for (const v of active) if (!v.imp) n++; if (n >= MAX_SFX) { stats.dropped++; return null; } }
      const g = gn(gain, bus); if (echo > 0) { const s = gn(echo, echoIn); g.connect(s); }
      const v = { g, end: t0 + .05, srcs: [], imp }; active.push(v); return v;
    }
    const track = (v, node, t1) => { node._t1 = t1; v.srcs.push(node); if (t1 > v.end) v.end = t1; return node; };
    // dest: undefined → the voice gain, null → nothing (LFOs), a node or an AudioParam otherwise
    function osc(v, type, f, t0, t1, dest) { const o = ctx.createOscillator(); o.type = type; o.frequency.value = f; if (dest === undefined) dest = v.g; if (dest) o.connect(dest); o.start(t0); o.stop(t1); return track(v, o, t1); }
    function noise(v, t0, t1, dest) { const s = ctx.createBufferSource(); s.buffer = noiseBuf; s.loop = true; s.connect(dest === undefined ? v.g : dest); s.start(t0, rnd() * 1.5); s.stop(t1); return track(v, s, t1); }
    function done(v) { let last = null; for (const s of v.srcs) if (!last || s._t1 > last._t1) last = s; if (last) last.onended = () => { try { v.g.disconnect(); } catch (e) { } }; v.srcs = null; }
    // linear attack, optional hold, exponential release; returns the end time
    const env = (p, t, a, peak, hold, rel) => { p.setValueAtTime(0, t); p.linearRampToValueAtTime(peak, t + a); if (hold > 0) p.setValueAtTime(peak, t + a + hold); p.exponentialRampToValueAtTime(.0008, t + a + hold + rel); return t + a + hold + rel; };
    const sweep = (p, t0, f0, t1, f1) => { p.setValueAtTime(Math.max(1, f0), t0); p.exponentialRampToValueAtTime(Math.max(1, f1), t1); };
    // a plain tone: type, frequency, start, attack, hold, release, level, optional filter cutoff
    function tone(v, type, f, t, a, hold, rel, lvl, cutoff) { const g = gn(0, v.g); let dest = g; if (cutoff) dest = filt('lowpass', cutoff, .8, g); const o = osc(v, type, f, t, env(g.gain, t, a, lvl, hold, rel) + .02, dest); return o; }

    /* ----- SFX ----- */
    const SFX = {
      click(o, t) { const v = voice(t, { gain: .3 }); if (!v) return; tone(v, 'sine', 1300, t, .002, 0, .045, 1); const hp = filt('highpass', 3500, 1, v.g), ng = gn(0, hp); noise(v, t, t + .03, ng); env(ng.gain, t, .001, .5, 0, .02); done(v); },
      open(o, t) { // a panel slides up: soft whoosh and a small bell
        const v = voice(t, { gain: .22, echo: .15 }); if (!v) return;
        const lp = filt('lowpass', 500, 1, v.g); sweep(lp.frequency, t, 500, t + .18, 2600); const ng = gn(0, lp); noise(v, t, t + .24, ng); env(ng.gain, t, .03, .5, 0, .18);
        tone(v, 'sine', 880, t + .08, .01, 0, .32, .9); tone(v, 'sine', 1760, t + .08, .01, 0, .18, .25); done(v);
      },
      bonk(o, t) { // the truck meets a wall: body thud, dust, a bit of sheet metal
        const a = clamp((+o.v || 10) / 22, .3, 1), v = voice(t, { gain: .75 * a }); if (!v) return;
        const g = gn(0, v.g), tri = osc(v, 'triangle', 140, t, t + .23, g); sweep(tri.frequency, t, 140, t + .2, 42); env(g.gain, t, .004, 1, 0, .2);
        const lp = filt('lowpass', 750, .8, v.g), ng = gn(0, lp); noise(v, t, t + .13, ng); env(ng.gain, t, .002, .7, 0, .11);
        tone(v, 'triangle', 430, t, .002, 0, .09, .25); done(v);
      },
      hit(o, t) { // knocking a crate, cone or letter over: a wooden knock
        const a = clamp((+o.v || 8) / 20, .25, 1), v = voice(t, { gain: .6 * a }); if (!v) return;
        const g = gn(0, v.g), s = osc(v, 'sine', 260, t, t + .11, g); sweep(s.frequency, t, 260, t + .09, 95); env(g.gain, t, .003, 1, 0, .09);
        const bp = filt('bandpass', 1600, 1.4, v.g), ng = gn(0, bp); noise(v, t, t + .07, ng); env(ng.gain, t, .001, .7, 0, .05); done(v);
      },
      land(o, t) { // wheels back on the ground; hard landings add a suspension rattle
        const hard = !!o.hard, v = voice(t, { gain: hard ? .6 : .32 }); if (!v) return;
        const g = gn(0, v.g), s = osc(v, 'sine', hard ? 95 : 110, t, t + (hard ? .3 : .15), g); sweep(s.frequency, t, hard ? 95 : 110, t + (hard ? .25 : .12), hard ? 36 : 60); env(g.gain, t, .004, 1, 0, hard ? .25 : .12);
        const lp = filt('lowpass', hard ? 520 : 400, .7, v.g), ng = gn(0, lp); noise(v, t, t + .16, ng); env(ng.gain, t, .002, hard ? .8 : .4, 0, hard ? .13 : .07);
        if (hard) { const bp = filt('bandpass', 2600, 2, v.g), rg = gn(0, bp); noise(v, t + .02, t + .11, rg); env(rg.gain, t + .02, .002, .18, 0, .06); } done(v);
      },
      horn(o, t) { // two-tone truck air horn (C4 + E4) with a little vibrato and echo
        const v = voice(t, { gain: .3, echo: .12, imp: true }); if (!v) return;
        const lp = filt('lowpass', 1900, 1, v.g), g = gn(0, lp), vib = osc(v, 'sine', 6, t, t + .8, null), vg = gn(3, null); vib.connect(vg);
        for (const f of [262, 330]) { const s = osc(v, 'sawtooth', f, t, t + .8, g), q = osc(v, 'square', f, t, t + .8, g); q.detune.value = 4; vg.connect(s.detune); vg.connect(q.detune); }
        const p = g.gain; p.setValueAtTime(0, t); p.linearRampToValueAtTime(.28, t + .035); p.setValueAtTime(.28, t + .6); p.exponentialRampToValueAtTime(.001, t + .78); done(v);
      },
      skid(o, t) { // tyres complaining in a hard turn
        const v = voice(t, { gain: .4 }); if (!v) return;
        const hp = filt('highpass', 500, .7, v.g), bp = filt('bandpass', 1500, 2.2, hp); sweep(bp.frequency, t, 1500, t + .5, 800);
        const ng = gn(0, bp); noise(v, t, t + .55, ng); const p = ng.gain; p.setValueAtTime(0, t); p.linearRampToValueAtTime(1, t + .04); p.setValueAtTime(1, t + .3); p.exponentialRampToValueAtTime(.001, t + .52); done(v);
      },
      refuel(o, t) { // pump hum, a few bubbles, the nozzle clunk
        const v = voice(t, { gain: .15 }); if (!v) return;
        const lp = filt('lowpass', 500, 1, v.g), hg = gn(0, lp); osc(v, 'sine', 95, t, t + 1.8, hg); const tri = osc(v, 'triangle', 190, t, t + 1.8, hg); tri.detune.value = 5;
        const p = hg.gain; p.setValueAtTime(0, t); p.linearRampToValueAtTime(.6, t + .15); p.setValueAtTime(.6, t + 1.4); p.linearRampToValueAtTime(0, t + 1.7);
        for (let i = 0; i < 7; i++) { const bt = t + .2 + i * .18 + hash(i, 3) * .08, bf = 420 + hash(i, 5) * 420; const bg = gn(0, v.g), b = osc(v, 'sine', bf, bt, bt + .07, bg); sweep(b.frequency, bt, bf, bt + .06, bf * 1.9); env(bg.gain, bt, .005, .35, 0, .05); }
        const cg = gn(0, v.g), c = osc(v, 'sine', 150, t + 1.55, t + 1.72, cg); sweep(c.frequency, t + 1.55, 150, t + 1.7, 85); env(cg.gain, t + 1.55, .003, .9, 0, .14); done(v);
      },
      collect(o, t) { const v = voice(t, { gain: .3, echo: .2 }); if (!v) return; tone(v, 'triangle', 880, t, .005, .02, .12, .8); tone(v, 'triangle', 1319, t + .07, .005, .03, .25, .8); tone(v, 'sine', 2637, t + .07, .005, 0, .18, .2); done(v); },
      checkpoint(o, t) { // bell-like E5 → A5
        const v = voice(t, { gain: .3, echo: .25 }); if (!v) return;
        tone(v, 'triangle', 659, t, .005, .04, .22, .8); tone(v, 'sine', 1318, t, .005, 0, .15, .25);
        tone(v, 'triangle', 880, t + .13, .005, .08, .45, .9); tone(v, 'sine', 1760, t + .13, .005, 0, .3, .3); done(v);
      },
      success(o, t) { // short fanfare up the pentatonic: A4 C5 E5 A5, the last held over its fifth
        const v = voice(t, { gain: .3, echo: .2, imp: true }); if (!v) return;
        [69, 72, 76].forEach((m, i) => { tone(v, 'sawtooth', mtof(m), t + i * .11, .01, .07, .1, .55, 2600); tone(v, 'triangle', mtof(m), t + i * .11, .01, .07, .1, .4); });
        tone(v, 'sawtooth', mtof(81), t + .33, .015, .45, .35, .55, 3200); tone(v, 'triangle', mtof(81), t + .33, .015, .45, .35, .45); tone(v, 'triangle', mtof(76), t + .36, .02, .42, .3, .3); done(v);
      },
      fail(o, t) { // E4 → C4 → A3 sagging down, with a low thud at the end
        const v = voice(t, { gain: .3, imp: true }); if (!v) return;
        [64, 60, 57].forEach((m, i) => { const f = mtof(m), g = gn(0, v.g), lp = filt('lowpass', 900, 1, g), o = osc(v, 'sawtooth', f, t + i * .2, t + i * .2 + .24, lp); o.frequency.setValueAtTime(f, t + i * .2); o.frequency.exponentialRampToValueAtTime(f * (i === 2 ? .9 : .97), t + i * .2 + .22); env(g.gain, t + i * .2, .015, .6, .1, .1); });
        const tg = gn(0, v.g), th = osc(v, 'sine', 90, t + .55, t + .8, tg); sweep(th.frequency, t + .55, 90, t + .78, 45); env(tg.gain, t + .55, .005, .8, 0, .22); done(v);
      },
      start(o, t) { // ignition: starter motor, the engine catching, a two-note chime
        const v = voice(t, { gain: .3, imp: true }); if (!v) return;
        const bp = filt('bandpass', 700, 1.2, v.g), cg = gn(0, bp); noise(v, t, t + .5, cg); const gate = osc(v, 'square', 11, t, t + .5, null), gg = gn(.35, cg.gain); gate.connect(gg); cg.gain.setValueAtTime(.4, t); cg.gain.linearRampToValueAtTime(0, t + .5);
        const kg = gn(0, v.g), k = osc(v, 'triangle', 120, t + .45, t + .75, kg); sweep(k.frequency, t + .45, 120, t + .7, 55); env(kg.gain, t + .45, .01, .9, 0, .25);
        tone(v, 'sine', 659, t + .6, .01, .05, .25, .5); tone(v, 'sine', 880, t + .72, .01, .1, .4, .55); done(v);
      },
      cargo(o, t) { // a crate lands on the bed, a strap clacks
        const v = voice(t, { gain: .5 }); if (!v) return;
        const g = gn(0, v.g), s = osc(v, 'sine', 170, t, t + .15, g); sweep(s.frequency, t, 170, t + .12, 105); env(g.gain, t, .004, 1, 0, .13);
        const bp = filt('bandpass', 800, 2, v.g), ng = gn(0, bp); noise(v, t, t + .1, ng); env(ng.gain, t, .002, .6, 0, .08);
        const bp2 = filt('bandpass', 2400, 3, v.g), n2 = gn(0, bp2); noise(v, t + .1, t + .15, n2); env(n2.gain, t + .1, .002, .35, 0, .04); done(v);
      },
      train(o, t) { // a freight loco's chord horn, far away: quieter and duller with distance, lots of echo
        let d = 120; if (typeof o.x === 'number' && W.car) d = Math.hypot(W.car.x - o.x, W.car.z - o.z);
        const near = clamp(1.25 - d / 200, .15, 1), v = voice(t, { gain: .32 * near, echo: .45, imp: true }); if (!v) return;
        const lp = filt('lowpass', clamp(1500 - d * 5, 450, 1500), .8, v.g), g = gn(0, lp), am = osc(v, 'sine', 4.5, t, t + 1.6, null), ag = gn(.12, g.gain); am.connect(ag);
        for (const f of [155.6, 185, 207.7]) { const s = osc(v, 'sawtooth', f, t, t + 1.6, g); s.frequency.setValueAtTime(f * .985, t); s.frequency.exponentialRampToValueAtTime(f, t + .25); }
        const p = g.gain; p.setValueAtTime(0, t); p.linearRampToValueAtTime(.3, t + .12); p.setValueAtTime(.3, t + 1.1); p.exponentialRampToValueAtTime(.001, t + 1.55); done(v);
      },
      cash(o, t) { // coins: two bright pings with a metallic partial
        const v = voice(t, { gain: .26, echo: .15 }); if (!v) return;
        tone(v, 'sine', 1568, t, .003, .01, .22, .8); tone(v, 'sine', 1568 * 2.76, t, .003, 0, .08, .25);
        tone(v, 'sine', 2093, t + .075, .003, .02, .3, .8); tone(v, 'sine', 2093 * 2.76, t + .075, .003, 0, .1, .22); done(v);
      }
    };
    // bursty names are rate-limited (seconds); a wall scrape must not fire sixty times a second
    const GAP = { bonk: .18, hit: .09, skid: .35, land: .15, click: .04, horn: .35, cargo: .12, collect: .06, open: .15, train: .8, checkpoint: .1, success: .3, fail: .3, cash: .06, refuel: .5, start: .5 };
    const last = {}, recent = [];
    let muted = false;
    function sfx(name, opts) {
      const fn = SFX[name]; if (!fn || muted) return;
      const tp = performance.now() / 1000;
      if (tp - (last[name] || -9) < (GAP[name] || .05)) return;
      while (recent.length && tp - recent[0] > .1) recent.shift();
      if (recent.length >= 8) { stats.dropped++; return; }                      // global burst guard
      recent.push(tp); last[name] = tp;
      fn(opts || {}, now() + .005); stats.sfxPlayed++;
    }

    /* ----- engine: two detuned saws and a sub through a lowpass, exhaust noise, a chug LFO on the gain ----- */
    const eng = (() => {
      const g = gn(0, engineBus), lp = filt('lowpass', 320, 1.1, g);
      const mk = (type, f, det, dest) => { const o = ctx.createOscillator(); o.type = type; o.frequency.value = f; o.detune.value = det; o.connect(dest); o.start(); return o; };
      const o1 = mk('sawtooth', 55, 0, lp), o2 = mk('sawtooth', 55, 12, lp), sub = mk('triangle', 27.5, 0, gn(.7, lp));
      const ng = gn(0, g), bp = filt('bandpass', 700, .7, ng), nz = ctx.createBufferSource(); nz.buffer = noiseBuf; nz.loop = true; nz.connect(bp); nz.start();
      const lfoG = gn(0, g.gain), lfo = mk('triangle', 27, 0, lfoG);
      return { g, lp, o1, o2, sub, ng, bp, lfo, lfoG, f: 55, lvl: 0, cut: 320, nf: 700, nl: 0 };
    })();
    function engine(speed01, throttle01, airborne) {
      const s = clamp(+speed01 || 0, 0, 1), th = clamp(+throttle01 || 0, 0, 1), air = !!airborne, empty = !!(W.car && W.car.fuel <= 0);
      const f = 55 + 105 * s + th * 9 * (1 - s) + (air ? 14 : 0) - (empty ? 8 : 0);
      let lvl = .07 + .17 * s + .09 * th; if (air) lvl *= .5; if (empty) lvl *= .7; if (!W.started) lvl = 0;
      const cut = 300 + 950 * s + 350 * th, nf = 600 + 1400 * s, nl = (.25 + .75 * th) * lvl * .9 * (air ? .6 : 1);
      const t = now(), near = (a, b) => Math.abs(a - b) <= Math.abs(b) * .004 + 1e-4;
      if (!near(f, eng.f)) { eng.f = f; eng.o1.frequency.setTargetAtTime(f, t, .12); eng.o2.frequency.setTargetAtTime(f, t, .12); eng.sub.frequency.setTargetAtTime(f / 2, t, .12); eng.lfo.frequency.setTargetAtTime(f / 2, t, .12); }
      if (!near(lvl, eng.lvl)) { eng.g.gain.setTargetAtTime(lvl, t, lvl > eng.lvl ? .12 : .3); eng.lfoG.gain.setTargetAtTime(lvl * .35, t, .15); eng.lvl = lvl; }
      if (!near(cut, eng.cut)) { eng.cut = cut; eng.lp.frequency.setTargetAtTime(cut, t, .15); }
      if (!near(nf, eng.nf)) { eng.nf = nf; eng.bp.frequency.setTargetAtTime(nf, t, .15); }
      if (!near(nl, eng.nl)) { eng.nl = nl; eng.ng.gain.setTargetAtTime(nl, t, .15); }
      stats.engine = { f: Math.round(f), lvl: +lvl.toFixed(3) };
    }

    /* ----- music ----- */
    let mus = null;
    function startDrone(t) { // morin-khuur-like: saws on A2 (+ a soft fifth) and a sub, lowpassed, slow vibrato, breathing cutoff
      const g = gn(0, musicBus), lp = filt('lowpass', 380, 1.4, g);
      const mk = (type, f, det, lvl) => { const o = ctx.createOscillator(); o.type = type; o.frequency.value = f; o.detune.value = det; o.connect(gn(lvl, lp)); o.start(t); return o; };
      const saws = [mk('sawtooth', 110, 0, .5), mk('sawtooth', 110, 5, .5), mk('sawtooth', 164.81, -3, .22)], sub = mk('triangle', 55, 0, .6);
      const vib = ctx.createOscillator(); vib.frequency.value = .8; const vg = gn(4, null); vib.connect(vg); saws.forEach(o => vg.connect(o.detune)); vib.start(t);
      const breath = ctx.createOscillator(); breath.frequency.value = .11; breath.connect(gn(130, lp.frequency)); breath.start(t);
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(.34, t + 2.5);
      return { g, nodes: [...saws, sub, vib, breath] };
    }
    function stopDrone(d) { const t = now(); d.g.gain.cancelScheduledValues(t); d.g.gain.setValueAtTime(d.g.gain.value, t); d.g.gain.linearRampToValueAtTime(0, t + .8); for (const n of d.nodes) { try { n.stop(t + .9); } catch (e) { } } setTimeout(() => { try { d.g.disconnect(); } catch (e) { } }, 1200); }
    function lead(m, t, dur, grace) { // bowed string: two saws sliding into the note, late vibrato, lowpass that follows the pitch
      const f = mtof(m), tEnd = t + Math.max(.12, dur - .06), tOff = tEnd + .25;
      if (grace) { // ornament: a quick scale neighbour just before the beat
        const i = SCALE.indexOf(m), gm = i < 0 ? m + 2 : i === SCALE.length - 1 ? SCALE[i - 1] : SCALE[i + 1], gf = mtof(gm);
        const gv = voice(t - .09, { bus: musicBus, gain: .3, imp: true }); if (gv) { const lp = filt('lowpass', Math.min(5000, gf * 3), .8, gv.g), g = gn(0, lp); osc(gv, 'sawtooth', gf, t - .09, t + .03, g); env(g.gain, t - .09, .02, 1, .04, .05); done(gv); }
      }
      const v = voice(t, { bus: musicBus, gain: .5, imp: true }); if (!v) return;
      const lp = filt('lowpass', Math.min(5200, f * 3.4), .9, v.g), g = gn(0, lp);
      const o1 = osc(v, 'sawtooth', f, t, tOff, g), o2 = osc(v, 'sawtooth', f, t, tOff, g); o2.detune.value = 7;
      for (const o of [o1, o2]) { o.frequency.setValueAtTime(f * .972, t); o.frequency.exponentialRampToValueAtTime(f, t + .07); }
      const lfo = osc(v, 'sine', 5.4, t, tOff, null), lg = gn(0, null); lfo.connect(lg); lg.connect(o1.detune); lg.connect(o2.detune);
      lg.gain.setValueAtTime(0, t); lg.gain.linearRampToValueAtTime(8, t + .4);
      const p = g.gain; p.setValueAtTime(0, t); p.linearRampToValueAtTime(1, t + .07); p.setTargetAtTime(.72, t + .07, .3); p.setTargetAtTime(0, tEnd, .05); done(v);
    }
    function bass(m, t, dur) { // the low voice an octave down: softer, rounder
      const f = mtof(m), v = voice(t, { bus: musicBus, gain: .28, imp: true }); if (!v) return;
      const lp = filt('lowpass', Math.min(1200, f * 2.6), 1, v.g), g = gn(0, lp); osc(v, 'sawtooth', f, t, t + dur + .25, g); osc(v, 'triangle', f, t, t + dur + .25, g);
      const p = g.gain; p.setValueAtTime(0, t); p.linearRampToValueAtTime(1, t + .1); p.setTargetAtTime(.7, t + .1, .3); p.setTargetAtTime(0, t + dur - .06, .06); done(v);
    }
    function dum(t, a) { // frame drum, palm: resonant lowpass noise plus a dropping sine body
      const v = voice(t, { bus: musicBus, gain: .55 * a, imp: true }); if (!v) return;
      const lp = filt('lowpass', 170, 5, v.g), ng = gn(0, lp); noise(v, t, t + .26, ng); env(ng.gain, t, .004, 1, 0, .2);
      const bg = gn(0, v.g), b = osc(v, 'sine', 85, t, t + .2, bg); sweep(b.frequency, t, 85, t + .18, 50); env(bg.gain, t, .005, .9, 0, .17); done(v);
    }
    function tek(t, a) { // frame drum, fingers on the rim
      const v = voice(t, { bus: musicBus, gain: a, imp: true }); if (!v) return;
      const bp = filt('bandpass', 2300, 1.3, v.g), ng = gn(0, bp); noise(v, t, t + .09, ng); env(ng.gain, t, .002, 1, 0, .06); tone(v, 'sine', 900, t, .002, 0, .02, .3); done(v);
    }
    function scheduleStep(step, t, L) {
      const bar = step >> 3, beat = step & 7, notes = BY_STEP[step];
      if (notes) for (const n of notes) {
        const dur = n[2] * EIGHTH, grace = n[2] >= 2 && hash(L * 7 + 1, step) < .3;
        lead(n[1], t, dur, grace); if (BASS_BARS.has(bar) && n[2] >= 2) bass(n[1] - 12, t, dur); stats.notesScheduled++;
      }
      const full = bar >= 4 || L > 0;
      if (beat === 0) dum(t, 1); else if (beat === 4) dum(t, .8);
      if (full) { if (beat === 3 || beat === 6) tek(t, .22); if (beat === 7 && hash(L, bar) < .5) tek(t, .12); if (beat === 2 && hash(L + 3, bar) < .3) tek(t, .1); }
    }
    function schedule(until) {
      const tNow = now();
      if (mus.next < tNow - .25) { const skip = Math.ceil((tNow - mus.next) / EIGHTH); mus.step = (mus.step + skip) % STEPS; mus.next += skip * EIGHTH; } // tab was asleep: jump, don't catch up
      while (mus.next < until) { scheduleStep(mus.step, mus.next, mus.loop); if (++mus.step >= STEPS) { mus.step = 0; mus.loop++; } mus.next += EIGHTH; }
      stats.step = mus.step; stats.loop = mus.loop;
    }
    function tick() { try { if (mus) schedule(now() + LOOK); } catch (e) { } }
    function music(on) {
      if (on && !mus) { mus = { step: 0, loop: 0, next: now() + .15, drone: startDrone(now()), timer: setInterval(tick, 100) }; tick(); }
      else if (!on && mus) { clearInterval(mus.timer); stopDrone(mus.drone); mus = null; }
    }
    function scheduleAhead(until) { if (mus) { clearInterval(mus.timer); schedule(until); } } // offline renders only
    function setMuted(m) { muted = !!m; const t = now(); master.gain.cancelScheduledValues(t); master.gain.setTargetAtTime(muted ? 0 : 1, t, .03); }
    return { ctx, sfx, engine, music, setMuted, scheduleAhead, stats };
  }

  /* ---------------- live context, lifecycle ---------------- */
  let live = null, wantMusic = false, listening = false;
  const resume = () => { try { if (live && live.ctx.state !== 'running' && live.ctx.state !== 'closed') live.ctx.resume().catch(() => { }); } catch (e) { } }; // also covers iOS 'interrupted'
  function listen() {
    if (listening) return; listening = true;
    document.addEventListener('visibilitychange', () => { try { if (!live) return; if (document.hidden) { if (live.ctx.state === 'running') live.ctx.suspend().catch(() => { }); } else resume(); } catch (e) { } });
    addEventListener('pointerdown', resume, { passive: true }); addEventListener('touchend', resume, { passive: true }); addEventListener('click', resume); addEventListener('keydown', resume);
  }
  function init() { // runs on the Start click (a user gesture); safe to call again
    try {
      if (live) { resume(); return; }
      if (!AC) return;
      const ctx = new AC({ latencyHint: 'interactive' });
      live = makeSynth(ctx, A.debug); live.setMuted(A.muted);
      A.ready = true; A.debug.state = ctx.state; ctx.onstatechange = () => { A.debug.state = ctx.state; };
      listen(); resume();
      if (wantMusic) live.music(true);
      live.sfx('start');
    } catch (e) { console.warn('audio: init failed', e); }
  }
  function sfx(name, opts) { try { if (live) live.sfx(name, opts); } catch (e) { } }
  function engine(speed01, throttle01, airborne) { try { if (live) live.engine(speed01, throttle01, airborne); } catch (e) { } }
  function music(on) { wantMusic = !!on; try { if (live) live.music(wantMusic); } catch (e) { } }
  function setMuted(m) {
    m = !!m; const changed = m !== A.muted; A.muted = m;
    try { localStorage.setItem(LS, m ? '1' : '0'); } catch (e) { }
    reflect();
    try { if (live) live.setMuted(m); } catch (e) { }
    if (changed && W.started) { try { W.toast(m ? 'Muted' : 'Sound on'); } catch (e) { } if (!m) sfx('click'); }
  }

  /* ---------------- the mute chip (the M key in core.js calls setMuted too; both end up here) ---------------- */
  let chip = null;
  try { if (W.hud && W.hud.button) chip = W.hud.button('♪ Sound', () => setMuted(!A.muted), { id: 'muteBtn', title: 'Sound (M)' }); } catch (e) { }
  function reflect() {
    if (!chip) return;
    chip.classList.toggle('on', !A.muted); chip.textContent = A.muted ? '♪ Muted' : '♪ Sound';
    chip.title = A.muted ? 'Sound is off · M to unmute' : 'Sound is on · M to mute'; chip.setAttribute('aria-pressed', String(!A.muted));
  }
  reflect();

  /* ---------------- offline render for the test harness: peak and RMS of one sound ---------------- */
  A.debug.render = (what, secs = 1.5) => new Promise((res, rej) => {
    try {
      const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext, sr = 44100, oc = new OAC(1, Math.ceil(sr * secs), sr), s = makeSynth(oc);
      if (what === 'music') { s.music(true); s.scheduleAhead(secs + .5); } else if (what === 'engine') s.engine(.6, 1, false); else s.sfx(what, { v: 15, hard: true, x: 0, z: 0 });
      oc.startRendering().then(buf => { const d = buf.getChannelData(0); let peak = 0, sum = 0; for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; sum += d[i] * d[i]; } res({ what, peak: +peak.toFixed(3), rms: +Math.sqrt(sum / d.length).toFixed(4), notes: s.stats.notesScheduled, voices: s.stats.voices }); }).catch(rej);
    } catch (e) { rej(e); }
  });
})();
