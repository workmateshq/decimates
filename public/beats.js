// Fallback beats, synthesized live with the Web Audio API, used only if a backing track (tracks.js)
// can't be loaded.
//
//   const beat = RapmatesBeats.createBeat(audioCtx, outputNode, 'trap' | 'boombap', { bpm, introBars });
//   beat.start(atTime);       // atTime in audioCtx time: beat 1 of bar 1. A time in the past starts
//                             // part-way through, as if it had started then (late joiners)
//   beat.onBeat((beatIndex, time) => {}); // called as each beat is scheduled (time is audio time)
//   beat.stop(atTime);        // fades out at atTime (default: now)
//
// The first `introBars` bars are a stripped-back intro (no kick, snare or bass).
(function (root) {
  const CATALOGUE = {
    trap: { name: '808 Trap', bpm: 130, introBars: 1 },
    boombap: { name: 'Boom Bap', bpm: 90, introBars: 1 },
  };

  const LOOKAHEAD_S = 0.1; // schedule this far ahead
  const TIMER_MS = 25; // how often the scheduler wakes up
  const STEPS_PER_BEAT = 4; // 16th notes
  const STEPS_PER_BAR = 16;

  const noteHz = (midi) => 440 * 2 ** ((midi - 69) / 12);

  // A worker-driven timer keeps scheduling smooth when the tab is in the background (plain timers
  // get throttled to once a second there, which would leave gaps in the beat).
  function createTimer(fn, ms) {
    try {
      const src = 'let t=null;onmessage=(e)=>{clearInterval(t);if(e.data>0)t=setInterval(()=>postMessage(0),e.data);};';
      const worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      worker.onmessage = fn;
      worker.postMessage(ms);
      return () => worker.terminate();
    } catch {
      const id = setInterval(fn, ms);
      return () => clearInterval(id);
    }
  }

  const noiseCache = new WeakMap();
  function noiseBuffer(ctx) {
    if (!noiseCache.has(ctx)) {
      const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      noiseCache.set(ctx, buf);
    }
    return noiseCache.get(ctx);
  }

  // Vinyl crackle: sparse random pops over quiet hiss.
  const crackleCache = new WeakMap();
  function crackleBuffer(ctx) {
    if (!crackleCache.has(ctx)) {
      const buf = ctx.createBuffer(1, ctx.sampleRate * 3, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) {
        d[i] = (Math.random() * 2 - 1) * 0.05;
        if (Math.random() < 0.0009) {
          const amp = 0.3 + Math.random() * 0.7;
          for (let k = 0; k < 40 && i + k < d.length; k++) d[i + k] += amp * (Math.random() * 2 - 1) * (1 - k / 40);
        }
      }
      crackleCache.set(ctx, buf);
    }
    return crackleCache.get(ctx);
  }

  function shaperCurve(amount) {
    const n = 2048;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1;
      curve[i] = ((1 + amount) * x) / (1 + amount * Math.abs(x));
    }
    return curve;
  }
  // Coarse steps, like a low-bit sampler.
  function crushCurve(levels) {
    const n = 4096;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1;
      curve[i] = Math.round(x * levels) / levels;
    }
    return curve;
  }

  function createBeat(ctx, out, kind, options = {}) {
    const spec = { ...(CATALOGUE[kind] || CATALOGUE.trap), ...options };
    const bpm = spec.bpm;
    const stepDur = 60 / bpm / STEPS_PER_BEAT;
    const beatListeners = [];

    // Bus: everything -> glue compressor -> volume -> out.
    const bus = ctx.createGain();
    bus.gain.value = 0.85;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 8;
    comp.ratio.value = 4;
    comp.attack.value = 0.005;
    comp.release.value = 0.15;
    const vol = ctx.createGain();
    vol.gain.value = kind === 'boombap' ? 1.0 : 0.7; // roughly level-matched
    bus.connect(comp).connect(vol).connect(out);

    let t0 = 0;
    let nextStep = 0;
    let stopAt = Infinity;
    let stopTimer = null;
    let running = false;

    // ---------- instruments ----------

    function env(t, peak, attack, decay, dest = bus) {
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(peak, t + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
      g.connect(dest);
      return g;
    }

    function noise(t, dur, filterType, freq, q, peak, decay, dest = bus) {
      const src = ctx.createBufferSource();
      src.buffer = noiseBuffer(ctx);
      const f = ctx.createBiquadFilter();
      f.type = filterType;
      f.frequency.value = freq;
      f.Q.value = q;
      src.connect(f).connect(env(t, peak, 0.001, decay, dest));
      src.start(t, Math.random() * 1.5);
      src.stop(t + dur);
    }

    function tone(t, type, f0, f1, glide, peak, attack, decay, dest = bus) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(f0, t);
      if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + glide);
      o.connect(env(t, peak, attack, decay, dest));
      o.start(t);
      o.stop(t + attack + decay + 0.05);
      return o;
    }

    const kick = (t, peak = 0.9, punch = 150) => {
      tone(t, 'sine', punch, 45, 0.12, peak, 0.002, 0.28);
      noise(t, 0.02, 'highpass', 2500, 0.7, 0.12, 0.012);
    };

    // 808: a sine that drops in pitch onto the note and sustains, with soft clipping for grit.
    const sat808 = ctx.createWaveShaper();
    sat808.curve = shaperCurve(4);
    const lp808 = ctx.createBiquadFilter();
    lp808.type = 'lowpass';
    lp808.frequency.value = 900;
    const g808 = ctx.createGain();
    g808.gain.value = 0.3;
    sat808.connect(lp808).connect(g808).connect(bus);
    function bass808(t, hz, len, peak = 0.9) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(hz * 2.2, t);
      o.frequency.exponentialRampToValueAtTime(hz, t + 0.06);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(peak, t + 0.005);
      g.gain.setTargetAtTime(peak * 0.55, t + 0.05, 0.15);
      g.gain.setTargetAtTime(0.0001, t + len, 0.06);
      o.connect(g).connect(sat808);
      o.start(t);
      o.stop(t + len + 0.4);
    }

    const clap = (t, peak = 0.55) => {
      [0, 0.011, 0.022].forEach((d) => noise(t + d, 0.03, 'bandpass', 1500, 1.2, peak * 0.7, 0.012));
      noise(t + 0.03, 0.25, 'bandpass', 1300, 0.9, peak, 0.18);
      noise(t, 0.12, 'highpass', 4000, 0.6, peak * 0.25, 0.08);
    };

    const hat = (t, peak = 0.18, open = false) => {
      noise(t, open ? 0.4 : 0.05, 'highpass', 7500, 0.8, peak, open ? 0.28 : 0.035);
      noise(t, 0.03, 'bandpass', 10500, 1.5, peak * 0.6, 0.02);
    };

    // Quiet, dark bell for the trap melody.
    const bellOut = ctx.createGain();
    bellOut.gain.value = 0.16;
    const bellDelay = ctx.createDelay(1);
    bellDelay.delayTime.value = stepDur * 3;
    const bellFb = ctx.createGain();
    bellFb.gain.value = 0.3;
    bellOut.connect(bus);
    bellOut.connect(bellDelay).connect(bellFb).connect(bellDelay);
    bellFb.connect(bus);
    const bell = (t, hz) => {
      tone(t, 'sine', hz, hz, 0, 0.5, 0.003, 1.1, bellOut);
      tone(t, 'sine', hz * 2.76, hz * 2.76, 0, 0.12, 0.002, 0.35, bellOut);
      tone(t, 'triangle', hz * 2, hz * 2, 0, 0.08, 0.002, 0.25, bellOut);
    };

    // Dark minor pad (saws through a low-pass), used under the trap beat.
    const padOut = ctx.createBiquadFilter();
    padOut.type = 'lowpass';
    padOut.frequency.value = 700;
    padOut.Q.value = 0.5;
    const padGain = ctx.createGain();
    padGain.gain.value = 0.05;
    padOut.connect(padGain).connect(bus);
    function pad(t, notes, len) {
      notes.forEach((m) => [-7, 7].forEach((cents) => {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = noteHz(m);
        o.detune.value = cents;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.25, t + 0.4);
        g.gain.setValueAtTime(0.25, t + len - 0.3);
        g.gain.linearRampToValueAtTime(0.0001, t + len);
        o.connect(g).connect(padOut);
        o.start(t);
        o.stop(t + len + 0.05);
      }));
    }

    // Boom bap: a gritty, low-passed, bit-crushed "sampled" chord stab.
    const stabCrush = ctx.createWaveShaper();
    stabCrush.curve = crushCurve(14);
    const stabLp = ctx.createBiquadFilter();
    stabLp.type = 'lowpass';
    stabLp.frequency.value = 1500;
    const stabGain = ctx.createGain();
    stabGain.gain.value = 0.11;
    stabCrush.connect(stabLp).connect(stabGain).connect(bus);
    function stab(t, notes, len) {
      notes.forEach((m, i) => [-12, 9].forEach((cents) => {
        const o = ctx.createOscillator();
        o.type = i === 0 ? 'triangle' : 'sawtooth';
        o.frequency.value = noteHz(m);
        o.detune.value = cents;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.35, t + 0.006);
        g.gain.exponentialRampToValueAtTime(0.12, t + 0.12);
        g.gain.exponentialRampToValueAtTime(0.0001, t + len);
        o.connect(g).connect(stabCrush);
        o.start(t);
        o.stop(t + len + 0.05);
      }));
    }

    // Upright-ish bass: a plucked sine + triangle with a soft low-pass.
    const upLp = ctx.createBiquadFilter();
    upLp.type = 'lowpass';
    upLp.frequency.value = 500;
    const upGain = ctx.createGain();
    upGain.gain.value = 0.5;
    upLp.connect(upGain).connect(bus);
    function upright(t, m, len) {
      const hz = noteHz(m);
      tone(t, 'sine', hz, hz, 0, 0.8, 0.008, len, upLp);
      tone(t, 'triangle', hz, hz, 0, 0.3, 0.004, len * 0.5, upLp);
      noise(t, 0.03, 'bandpass', 700, 2, 0.06, 0.02, upLp);
    }

    const crunch = ctx.createWaveShaper();
    crunch.curve = shaperCurve(2.5);
    const crunchGain = ctx.createGain();
    crunchGain.gain.value = 0.8;
    crunch.connect(crunchGain).connect(bus);
    const dustySnare = (t, peak = 0.7) => {
      tone(t, 'triangle', 220, 160, 0.05, peak * 0.6, 0.001, 0.12, crunch);
      noise(t, 0.25, 'bandpass', 2200, 0.7, peak, 0.17, crunch);
      noise(t, 0.12, 'highpass', 5000, 0.5, peak * 0.3, 0.08, crunch);
    };
    const dustyKick = (t, peak = 1) => {
      tone(t, 'sine', 120, 48, 0.09, peak, 0.002, 0.3, crunch);
      noise(t, 0.02, 'lowpass', 1200, 0.7, 0.25, 0.015, crunch);
    };

    let crackleSrc = null;
    function startCrackle(t) {
      const src = ctx.createBufferSource();
      src.buffer = crackleBuffer(ctx);
      src.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = 3000;
      f.Q.value = 0.4;
      const g = ctx.createGain();
      g.gain.value = 0.35;
      src.connect(f).connect(g).connect(bus);
      src.start(Math.max(t, ctx.currentTime));
      crackleSrc = src;
    }

    // ---------- patterns ----------

    // 808 trap in A minor, half-time feel (clap on beat 3). Am - F - C - G under it.
    const TRAP_ROOTS = [33, 29, 36, 31]; // A1 F1 C2 G1
    const TRAP_PADS = [[57, 60, 64], [53, 57, 60], [55, 60, 64], [55, 59, 62]];
    const TRAP_BELL = [[0, 76], [3, 72], [6, 69], [10, 72], [12, 74]]; // step, midi
    const TRAP_BELL_B = [[0, 72], [3, 71], [6, 67], [8, 69], [11, 64]];
    function trapStep(step, t) {
      const bar = Math.floor(step / STEPS_PER_BAR);
      const s = step % STEPS_PER_BAR;
      const intro = bar < (spec.introBars || 0);
      const phrase = bar % 4;
      const root = noteHz(TRAP_ROOTS[phrase]);
      if (s === 0) pad(t, TRAP_PADS[phrase], stepDur * 16);
      // Hats: straight 8ths, with 16ths in the second half and a triplet roll at the end of every other bar.
      const roll = phrase % 2 === 1 && s >= 12;
      if (roll) {
        if (s === 12 || s === 14) for (let k = 0; k < 3; k++) hat(t + (k * stepDur * 2) / 3, 0.12 + k * 0.03);
      } else if (s % 2 === 0 || s >= 8) {
        hat(t, s % 4 === 0 ? 0.2 : 0.12);
      }
      if (s === 14 && phrase === 2) hat(t, 0.12, true);
      if (s === 6 && phrase === 0) hat(t + stepDur / 2, 0.1); // a little stutter
      (phrase % 2 ? TRAP_BELL_B : TRAP_BELL).forEach(([st, m]) => { if (st === s) bell(t, noteHz(m)); });
      if (intro) return;
      if (s === 8) clap(t);
      const kicks = phrase === 3 ? [0, 3, 7, 10, 14] : [0, 7, 10];
      if (kicks.includes(s)) {
        kick(t);
        const next = kicks.find((k) => k > s) ?? 16;
        const hz = s === 10 && phrase === 1 ? root * 1.5 : root; // a fifth for movement
        bass808(t, hz, (next - s) * stepDur * 0.95);
      }
    }

    // Boom bap in D minor: Dm - Bb - Gm - A. Swung 16ths.
    const BB_CHORDS = [[62, 65, 69], [58, 62, 65], [55, 58, 62], [57, 61, 64]];
    const BB_BASS = [[38, 38, 45], [34, 34, 41], [31, 31, 38], [33, 33, 40]];
    const SWING = 0.3; // offbeat 16ths land this fraction of a step late
    function boomStep(step, t) {
      const bar = Math.floor(step / STEPS_PER_BAR);
      const s = step % STEPS_PER_BAR;
      const intro = bar < (spec.introBars || 0);
      const phrase = bar % 4;
      const swung = t + (s % 2 === 1 ? SWING * stepDur : 0) + (s % 4 === 2 ? SWING * 0.6 * stepDur : 0);
      if (s % 2 === 0) hat(swung, s % 4 === 0 ? 0.15 : 0.09);
      if (s === 15 && phrase === 3) hat(swung, 0.07);
      if (s === 0) stab(t, BB_CHORDS[phrase], stepDur * 5);
      if (s === 6 || s === 10) stab(swung, BB_CHORDS[phrase], stepDur * 2);
      if (intro) return;
      if (s === 4 || s === 12) dustySnare(t);
      if (s === 15 && phrase === 1) dustySnare(swung, 0.25); // ghost
      const kicks = phrase === 3 ? [0, 3, 6, 10] : [0, 6, 7, 10];
      if (kicks.includes(s)) dustyKick(s === 7 ? swung : t, s === 0 ? 1 : 0.8);
      const bassHits = { 0: 0, 6: 1, 10: 2 };
      if (s in bassHits) upright(s === 6 ? swung : t, BB_BASS[phrase][bassHits[s]], stepDur * (s === 0 ? 5 : 3.5));
    }

    function scheduleStep(step, t) {
      if (step % STEPS_PER_BEAT === 0) beatListeners.forEach((fn) => fn(step / STEPS_PER_BEAT, t));
      if (kind === 'boombap') boomStep(step, t);
      else trapStep(step, t);
    }

    let killScheduler = null;
    function tick() {
      const horizon = ctx.currentTime + LOOKAHEAD_S;
      while (running) {
        const t = t0 + nextStep * stepDur;
        if (t >= horizon) break;
        if (t >= stopAt) {
          running = false;
          break;
        }
        // Steps already in the past (starting late) are skipped rather than played all at once.
        if (t >= ctx.currentTime - 0.01) scheduleStep(nextStep, t);
        nextStep++;
      }
    }

    return {
      kind,
      bpm,
      name: spec.name,
      get startTime() {
        return t0;
      },
      start(atTime = ctx.currentTime + 0.05) {
        this.stop(0, true);
        bus.gain.cancelScheduledValues(0);
        bus.gain.setValueAtTime(0.85, ctx.currentTime);
        t0 = atTime;
        stopAt = Infinity;
        nextStep = Math.max(0, Math.floor((ctx.currentTime - atTime) / stepDur));
        running = true;
        if (kind === 'boombap') startCrackle(atTime);
        killScheduler = createTimer(tick, TIMER_MS);
        tick();
      },
      // Fades out over `fade` seconds from atTime (quiet: stop dead, used when restarting).
      stop(atTime = ctx.currentTime, quiet = false, fade = 0.4) {
        const when = Math.max(atTime, ctx.currentTime);
        stopAt = when;
        if (!quiet) {
          bus.gain.setValueAtTime(bus.gain.value, when);
          bus.gain.linearRampToValueAtTime(0.0001, when + fade);
        }
        const end = when + (quiet ? 0 : fade);
        if (crackleSrc) { try { crackleSrc.stop(end); } catch { /* already stopped */ } crackleSrc = null; }
        clearTimeout(stopTimer);
        const finish = () => {
          running = false;
          if (killScheduler) killScheduler();
          killScheduler = null;
        };
        if (quiet) finish();
        // Otherwise keep scheduling up to the stop time, then let the timer go.
        else stopTimer = setTimeout(finish, Math.max(0, (when - ctx.currentTime) * 1000) + 200);
      },
      // Disconnects everything (after the fade-out).
      dispose(afterSec = 1) {
        this.stop();
        setTimeout(() => { try { vol.disconnect(); } catch { /* gone */ } }, afterSec * 1000 + 500);
      },
      onBeat(fn) {
        beatListeners.push(fn);
      },
    };
  }

  root.RapmatesBeats = { CATALOGUE, createBeat };
})(typeof self !== 'undefined' ? self : this);
