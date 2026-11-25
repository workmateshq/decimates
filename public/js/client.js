(() => {
  const net = window.DecimatesNet.createNet();
  const Engine = window.DecimatesEngine;
  const Prompts = window.DecimatesPrompts;
  const PARAMS = new URLSearchParams(location.search);
  const DEBUG = PARAMS.has('debug');
  // ?debug&write=N shortens the write timer; ?debug&nointro skips the intro; ?debug&min=N needs N players
  // to start; ?debug&comic=1 (or 0) forces (or rules out) the comic final.
  const DEBUG_WRITE = DEBUG && PARAMS.has('write') ? Number(PARAMS.get('write')) || undefined : undefined;
  const startOptions = () => {
    const o = {};
    if (DEBUG_WRITE) o.writeSeconds = DEBUG_WRITE;
    if (DEBUG && PARAMS.has('nointro')) o.intro = false;
    if (DEBUG && PARAMS.has('min')) o.minPlayers = Number(PARAMS.get('min')) || 1;
    if (DEBUG && PARAMS.has('comic')) o.comicFinal = PARAMS.get('comic') !== '0';
    return Object.keys(o).length ? o : undefined;
  };
  const MIN_PLAYERS = DEBUG && PARAMS.has('min') ? Number(PARAMS.get('min')) || 1 : Engine.MIN_PLAYERS;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const reduceMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const state = {
    playerId: null,
    hostId: null,
    linkRoom: false, // entered via a link like /decimates/mate: no room code UI
    lobby: { players: [], crowd: [], started: false },
    game: null, // { order, totals }
    phase: null, // the latest phase payload from the host
    over: null, // the latest results
    away: false, // pressed Home mid-game: still in the room, not watching
  };

  // ---------- Sound ----------
  // One AudioContext: sound effects through the sfx gain (no music for now).
  let ac = null;
  let sfxGain = null;
  const soundPrefs = (() => {
    const read = (k) => { try { return localStorage.getItem(`decimates-${k}`) !== 'off'; } catch { return true; } };
    return { sfx: read('sfx') };
  })();

  function getAudioCtx() {
    if (!ac) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      ac = new Ctx({ latencyHint: 'interactive' });
      const comp = ac.createDynamicsCompressor();
      comp.threshold.value = -10;
      comp.ratio.value = 4;
      comp.connect(ac.destination);
      sfxGain = ac.createGain();
      sfxGain.connect(comp);
      applySoundPrefs();
    }
    if (ac.state === 'suspended') ac.resume().catch(() => {});
    return ac;
  }
  // Browsers only allow audio after a user gesture.
  ['pointerdown', 'keydown'].forEach((ev) => window.addEventListener(ev, () => { if (!ac || ac.state !== 'running') getAudioCtx(); }, true));

  function env(t, peak, attack, decay, dest = sfxGain) {
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    g.connect(dest);
    return g;
  }
  function tone(t, type, f0, f1, dur, peak, attack = 0.005, dest = sfxGain) {
    const o = ac.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    o.connect(env(t, peak, attack, dur, dest));
    o.start(t);
    o.stop(t + attack + dur + 0.05);
    return o;
  }
  let noiseBuf = null;
  function noiseSource() {
    if (!noiseBuf) {
      noiseBuf = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const src = ac.createBufferSource();
    src.buffer = noiseBuf;
    return src;
  }
  function noise(t, dur, type, freq, peak, q = 1, dest = sfxGain) {
    const src = noiseSource();
    const f = ac.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    src.connect(f).connect(env(t, peak, 0.003, dur, dest));
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.05);
  }

  // Recorded sounds (public/sound/), fetched and decoded once you're in a room.
  const samples = {}; // name -> AudioBuffer
  const sampleLoads = {};
  function loadSample(name) {
    const a = getAudioCtx();
    if (!a) return Promise.resolve(null);
    if (!sampleLoads[name]) {
      sampleLoads[name] = fetch(`sound/${name}.mp3`)
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(r.status))))
        .then((ab) => new Promise((res, rej) => a.decodeAudioData(ab, res, rej)))
        .then((b) => { samples[name] = b; return b; })
        .catch(() => { delete sampleLoads[name]; return null; });
    }
    return sampleLoads[name];
  }
  function playSample(name, gain = 1) {
    const buf = samples[name];
    if (!buf) return false;
    const src = ac.createBufferSource();
    src.buffer = buf;
    const g = ac.createGain();
    g.gain.value = gain;
    src.connect(g).connect(sfxGain);
    src.start();
    return true;
  }

  // Cartoon sound effects, synthesised (the explosion is a recording).
  const sfx = {
    uiHover() { tone(ac.currentTime, 'sine', 1900, 1600, 0.035, 0.05, 0.002); },
    uiClick() {
      const t = ac.currentTime;
      tone(t, 'triangle', 520, 880, 0.07, 0.18, 0.002);
      noise(t, 0.02, 'highpass', 3000, 0.06, 0.7);
    },
    // Slide whistle up: the prompt arrives.
    whistle() { tone(ac.currentTime, 'sine', 500, 1900, 0.45, 0.16, 0.02); },
    // A springy boing: an answer appears.
    boing() {
      const t = ac.currentTime;
      const o = ac.createOscillator();
      o.type = 'triangle';
      o.frequency.setValueAtTime(180, t);
      for (let i = 1; i <= 8; i++) o.frequency.linearRampToValueAtTime(180 + (i % 2 ? 160 : 40) * (1 - i / 9), t + i * 0.04);
      o.connect(env(t, 0.25, 0.005, 0.4));
      o.start(t);
      o.stop(t + 0.5);
    },
    pop() { tone(ac.currentTime, 'sine', 900, 300, 0.08, 0.2, 0.002); },
    submit() {
      const t = ac.currentTime;
      [0, 4, 7, 12].forEach((s, i) => tone(t + i * 0.06, 'square', 523 * 2 ** (s / 12), 523 * 2 ** (s / 12), 0.09, 0.07));
    },
    // Write-phase panic ticker: a clock tick, louder and higher in the last 3 seconds.
    tick(fast) {
      const t = ac.currentTime;
      tone(t, 'square', fast ? 1800 : 1300, fast ? 1800 : 1300, 0.025, fast ? 0.12 : 0.07, 0.001);
      noise(t, 0.02, 'highpass', 5000, fast ? 0.12 : 0.07, 0.7);
    },
    // KA-BOOM: sound/explosion.mp3 (or, until it's loaded, a noisy thump with a falling sub, then crackle).
    boom() {
      if (playSample('explosion', 1)) return;
      const t = ac.currentTime;
      tone(t, 'sine', 140, 30, 1.2, 0.9, 0.003);
      noise(t, 1.6, 'lowpass', 900, 0.9, 0.7);
      noise(t, 0.5, 'bandpass', 2200, 0.35, 0.6);
      for (let i = 0; i < 16; i++) noise(t + 0.2 + Math.random() * 1.2, 0.04, 'highpass', 2500, 0.15 * Math.random(), 1);
    },
    // A sad fizzle: the losing fuse goes out.
    fizzle() {
      const t = ac.currentTime;
      noise(t, 0.6, 'highpass', 4000, 0.12, 0.5);
      tone(t + 0.3, 'sine', 400, 120, 0.4, 0.08, 0.01);
    },
    // Game-show fanfare: a rising run into a held chord with sparkle on top.
    win() {
      const t0 = ac.currentTime + 0.02;
      const note = (t, freq, len, peak) => {
        const g = ac.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(peak, t + 0.015);
        g.gain.setValueAtTime(peak, t + len * 0.6);
        g.gain.exponentialRampToValueAtTime(0.0001, t + len);
        const f = ac.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = 3200;
        f.connect(g).connect(sfxGain);
        [-6, 6].forEach((cents) => {
          const o = ac.createOscillator();
          o.type = 'sawtooth';
          o.frequency.value = freq;
          o.detune.value = cents;
          o.connect(f);
          o.start(t);
          o.stop(t + len + 0.05);
        });
      };
      [392, 523.25, 659.25, 783.99].forEach((fr, i) => note(t0 + i * 0.11, fr, 0.14, 0.07));
      const hold = t0 + 0.46;
      [523.25, 659.25, 783.99, 1046.5].forEach((fr) => note(hold, fr, 1.3, 0.05));
      [2093, 2637, 3136, 4186].forEach((fr, i) => tone(hold + 0.05 + i * 0.07, 'sine', fr, fr, 0.5, 0.05));
    },
  };
  function playSfx(name, ...args) {
    if (!ac || ac.state !== 'running') return;
    sfx[name](...args);
  }

  // A lit fuse: a bright, fluttering hiss with random crackles and spits, getting louder as it burns down.
  // Returns a stop function.
  function fuseHiss(seconds) {
    if (!ac || ac.state !== 'running') return () => {};
    const t = ac.currentTime;
    const out = ac.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.linearRampToValueAtTime(0.14, t + 0.2);
    out.gain.linearRampToValueAtTime(0.24, t + Math.max(0.4, seconds));
    out.connect(sfxGain);
    // The hiss: white noise, high-passed, with a sizzly peak.
    const src = noiseSource();
    src.loop = true;
    const hp = ac.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 2600;
    const peak = ac.createBiquadFilter();
    peak.type = 'peaking';
    peak.frequency.value = 6500;
    peak.Q.value = 0.8;
    peak.gain.value = 9;
    // Flutter: two out-of-step wobbles on the level, so it sputters rather than drones.
    const wob = ac.createGain();
    wob.gain.value = 0.65;
    const lfos = [[11, 0.22], [17.3, 0.14]].map(([hz, depth]) => {
      const o = ac.createOscillator();
      o.frequency.value = hz;
      const d = ac.createGain();
      d.gain.value = depth;
      o.connect(d).connect(wob.gain);
      o.start(t);
      return o;
    });
    src.connect(hp).connect(peak).connect(wob).connect(out);
    src.start(t, Math.random());
    // Crackles: little bursts of spark.
    const crackle = setInterval(() => {
      if (ac.state !== 'running') return;
      const n = ac.currentTime;
      const count = 1 + Math.floor(Math.random() * 3);
      for (let i = 0; i < count; i++) {
        noise(n + Math.random() * 0.09, 0.004 + Math.random() * 0.012, 'highpass', 2500 + Math.random() * 4000, 0.3 + Math.random() * 0.5, 0.7, out);
      }
    }, 90);
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      clearInterval(crackle);
      const n = ac.currentTime;
      out.gain.cancelScheduledValues(n);
      out.gain.setValueAtTime(out.gain.value, n);
      out.gain.linearRampToValueAtTime(0.0001, n + 0.12);
      try { src.stop(n + 0.15); } catch { /* done */ }
      lfos.forEach((o) => { try { o.stop(n + 0.15); } catch { /* done */ } });
    };
  }

  // ---------- The announcer (speechSynthesis): reads the prompts ----------
  let voices = [];
  const loadVoices = () => { if (window.speechSynthesis) voices = window.speechSynthesis.getVoices() || []; };
  if (window.speechSynthesis) {
    loadVoices();
    window.speechSynthesis.addEventListener('voiceschanged', loadVoices);
  }
  const NOVELTY = /\b(albert|bad news|bahh|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|hysterical|grandma|grandpa|junior)\b/i;
  function announcerVoice() {
    if (!voices.length) loadVoices();
    const en = voices.filter((v) => /^en([-_]|$)/i.test(v.lang) && !NOVELTY.test(v.name));
    for (const name of ['Daniel', 'Google UK English Male', 'Microsoft Ryan', 'Arthur', 'Aaron', 'Microsoft Guy', 'Alex']) {
      const v = en.find((x) => x.name.includes(name));
      if (v) return v;
    }
    return en[0] || null;
  }
  // Lines queue up; cancel() clears them. Only with sound effects on.
  function say(text, { rate = 1.05, pitch = 1.1, cancel = false } = {}) {
    const synth = window.speechSynthesis;
    if (!synth || !soundPrefs.sfx || !text) return;
    if (cancel) synth.cancel();
    // Blanks ("___") are read out as "blank".
    const u = new SpeechSynthesisUtterance(text.replace(/_{2,}/g, ' blank '));
    const v = announcerVoice();
    if (v) {
      u.voice = v;
      u.lang = v.lang;
    }
    u.rate = rate;
    u.pitch = pitch;
    synth.speak(u);
  }
  const hush = () => { if (window.speechSynthesis) window.speechSynthesis.cancel(); };

  // ---------- Sound effects on/off ----------
  function applySoundPrefs() {
    if (sfxGain) sfxGain.gain.value = soundPrefs.sfx ? 0.8 : 0;
    if (!soundPrefs.sfx) hush();
    [['sfx-toggle', soundPrefs.sfx, 'Sound effects and voice']].forEach(([id, on, label]) => {
      const btn = $(id);
      btn.setAttribute('aria-pressed', String(on));
      btn.classList.toggle('off', !on);
      btn.title = `${label} ${on ? 'on' : 'off'} (click to turn ${on ? 'off' : 'on'})`;
    });
  }
  [['sfx-toggle', 'sfx']].forEach(([id, key]) => {
    $(id).addEventListener('click', (e) => {
      soundPrefs[key] = !soundPrefs[key];
      try { localStorage.setItem(`decimates-${key}`, soundPrefs[key] ? 'on' : 'off'); } catch { /* private mode */ }
      applySoundPrefs();
      if (e.detail) e.currentTarget.blur();
    });
  });
  applySoundPrefs();

  // ---------- Avatars ----------
  // DiceBear's "Initial Face" (CC0, https://www.dicebear.com/styles/initial-face/), seeded by name so everyone
  // sees the same face, in a disc of the player's colour.
  const avatarUrl = (name) => `https://api.dicebear.com/10.x/initial-face/svg?seed=${encodeURIComponent(name || 'Player')}`;
  const avatarImg = (name, cls = '', color = '') => `<img class="av ${cls}" src="${avatarUrl(name)}" alt="" draggable="false" decoding="async"${color ? ` style="--pc:${color}"` : ''}>`;
  function replay(el, cls) {
    if (!el) return;
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
  }

  // A bundle of "dynamite" that's really four hot dog sausages (the joke), tied with two loops of rope, and a
  // fuse poking out of one of them. The joke's label sits between the sausages and the ropes
  // (dynamiteRopes is drawn over it).
  const INK = '#1d1410';
  const DYN_STICKS = [[124, 64, 388], [128, 170, 390], [100, 114, 380], [146, 124, 392]]; // [left end x, centre y, right end x]
  const DYN_FUSE = 'M16 62 C 30 46, 46 84, 60 92 S 76 108, 86 112';
  function dynStick([x0, cy, x1], r = 30, e = 24) {
    // A sausage: a capsule with plump rounded ends, a glossy sheen and a few grill marks.
    const marks = [x0 + 18, x0 + 36, x1 - 34, x1 - 16].map((x) => `<path d="M${x - 7} ${cy + r * 0.55}L${x + 9} ${cy - r * 0.55}"/>`).join('');
    return `<path d="M${x0} ${cy - r}H${x1}A${e} ${r} 0 0 1 ${x1} ${cy + r}H${x0}A${e} ${r} 0 0 1 ${x0} ${cy - r}Z" fill="#c8553b" stroke="${INK}" stroke-width="2.6"/>
      <path d="M${x0 - 6} ${cy + r * 0.62}Q${(x0 + x1) / 2} ${cy + r * 0.82} ${x1 + 6} ${cy + r * 0.62}" fill="none" stroke="#9e3a24" stroke-width="7" stroke-linecap="round" opacity=".55"/>
      <path d="M${x0 + 2} ${cy - r * 0.5}Q${(x0 + x1) / 2} ${cy - r * 0.72} ${x1 - 2} ${cy - r * 0.5}" fill="none" stroke="#ec9274" stroke-width="5" stroke-linecap="round" opacity=".8"/>
      <g stroke="#6b2414" stroke-width="4" stroke-linecap="round" opacity=".55">${marks}</g>`;
  }
  function dynamiteSvg() {
    const sparks = Array.from({ length: 9 }, (_, i) => {
      const t = (i / 9) * Math.PI * 2 + 0.3;
      const [r0, r1] = i % 2 ? [17, 21] : [19, 26];
      return `<path d="M${(Math.cos(t) * r0).toFixed(1)} ${(Math.sin(t) * r0).toFixed(1)}L${(Math.cos(t) * r1).toFixed(1)} ${(Math.sin(t) * r1).toFixed(1)}"/>`;
    }).join('');
    const star = (ro, ri, n = 8) => Array.from({ length: n * 2 }, (_, i) => {
      const t = (i / (n * 2)) * Math.PI * 2 - Math.PI / 2;
      const rr = i % 2 ? ri : ro;
      return `${(Math.cos(t) * rr).toFixed(1)},${(Math.sin(t) * rr).toFixed(1)}`;
    }).join(' ');
    return `<svg class="dyn-svg" viewBox="0 0 420 220" aria-hidden="true">
      ${DYN_STICKS.map((st) => dynStick(st)).join('')}
      <path class="fuse" d="${DYN_FUSE}" fill="none" stroke="${INK}" stroke-width="7.5" stroke-linecap="round"/>
      <path class="fuse" d="${DYN_FUSE}" fill="none" stroke="#c9a46b" stroke-width="4.5" stroke-linecap="round"/>
      <g class="spark" transform="translate(16 62)">
        <g class="spark-bits" stroke="#f39a1e" stroke-width="2.4" stroke-linecap="round">${sparks}</g>
        <polygon class="spark-star" points="${star(15, 6)}" fill="#f07a1a" stroke="#d65a10" stroke-width="1.2" stroke-linejoin="round"/>
        <polygon class="spark-star" points="${star(8, 3.5)}" fill="#ffd23f"/>
      </g>
    </svg>`;
  }
  // A rope strap down each edge of the label, over it.
  function dynamiteRopes() {
    const rope = (x) => {
      const d = `M${x} 28C${x + 4} 70, ${x + 4} 168, ${x} 210`;
      return `<path d="${d}" stroke="${INK}" stroke-width="10"/><path d="${d}" stroke="#cfa86a" stroke-width="7"/><path d="${d}" stroke="#a07a48" stroke-width="7" stroke-dasharray="2.5 4.5"/>`;
    };
    return `<svg class="dyn-ropes" viewBox="0 0 420 220" aria-hidden="true" fill="none" stroke-linecap="round">${rope(160)}${rope(370)}</svg>`;
  }
  // How far the fuse has burnt (0 to 1): the spark rides the end of what's left.
  function setFuse(d, progress) {
    const paths = d.querySelectorAll('.fuse');
    const spark = d.querySelector('.spark');
    if (!paths.length || !spark) return;
    const len = d.fuseLen || (d.fuseLen = paths[0].getTotalLength());
    const p = Math.max(0, Math.min(1, progress));
    paths.forEach((f) => {
      f.style.strokeDasharray = `${len} ${len}`;
      f.style.strokeDashoffset = `${-p * len}`;
    });
    const pt = paths[0].getPointAtLength(p * len);
    spark.setAttribute('transform', `translate(${pt.x.toFixed(1)} ${pt.y.toFixed(1)})`);
    d.fuseAt = p;
  }
  // Burn the rest of the fuse quickly (just before it goes off).
  function burnOut(d, ms = 420) {
    const from = d.fuseAt || 0;
    const t0 = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - t0) / ms);
      setFuse(d, from + (1 - from) * k);
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // The background: a slow hypnotic spiral.
  (function drawSpiral() {
    const path = $('hypno-path');
    if (!path) return;
    const a = 24;
    let d = '';
    for (let t = 0; t <= 68; t += 0.05) d += `${t ? 'L' : 'M'}${(a * t * Math.cos(t)).toFixed(1)} ${(a * t * Math.sin(t)).toFixed(1)}`;
    path.setAttribute('d', d);
    path.setAttribute('stroke-width', (Math.PI * a).toFixed(1));
  })();
  // The logo's little bundle.
  if ($('logo-mark')) $('logo-mark').innerHTML = `<span class="dyn-art lit">${dynamiteSvg()}${dynamiteRopes()}</span>`;

  // ---------- Lobby ----------

  function showError(msg) { $('error-msg').textContent = msg || ''; }
  const isHost = () => state.playerId && state.playerId === state.hostId;
  const everyone = () => [...state.lobby.players, ...state.lobby.crowd];
  const me = () => everyone().find((m) => m.id === state.playerId);
  const nameOf = (m) => (m && m.id === state.playerId ? 'You' : (m && m.name) || 'Someone');
  const PREVIEW = { id: 'preview', number: 1, name: 'You', color: Engine.PLAYER_COLORS[0] };

  function buildSlots() {
    $('slots').replaceChildren(...Array.from({ length: Engine.MAX_PLAYERS }, (_, i) => i + 1).map((n) => {
      const slot = document.createElement('div');
      slot.className = 'slot';
      slot.innerHTML = `<span class="slot-num">P${n}</span><span class="avatar" aria-hidden="true"></span><span class="slot-name"></span><span class="slot-tag"></span>`;
      return slot;
    }));
  }
  function slotTag(p, isYou) {
    if (!p || p === PREVIEW) return '';
    return [isYou && 'You', !state.linkRoom && p.id === state.hostId && 'Host'].filter(Boolean).join(' · ');
  }
  function renderSlots() {
    const players = state.playerId ? state.lobby.players : [PREVIEW];
    [...$('slots').children].forEach((slot, i) => {
      const p = players.find((pl) => pl.number === i + 1);
      const isYou = p && (p.id === state.playerId || p === PREVIEW);
      const key = p ? `${p.id}|${p.name}` : '';
      if (slot.dataset.key !== key) {
        slot.dataset.key = key;
        slot.classList.toggle('filled', !!p);
        slot.classList.toggle('you', !!isYou);
        slot.style.setProperty('--pc', p ? p.color : '#ccc');
        slot.querySelector('.avatar').innerHTML = p ? avatarImg(p === PREVIEW ? savedName() || p.name : p.name) : '<span class="av av-empty"></span>';
        slot.querySelector('.slot-name').textContent = p ? p.name : 'Open seat';
      }
      slot.querySelector('.slot-tag').textContent = slotTag(p, isYou);
    });
    const crowd = state.lobby.crowd;
    $('crowd-line').hidden = !state.playerId || !crowd.length;
    $('crowd-line').innerHTML = `<b>Crowd: ${crowd.length}</b> `
      + crowd.map((m) => `<span class="chip${m.id === state.playerId ? ' you' : ''}">${esc(m.name)}${m.id === state.playerId ? ' (you)' : ''}</span>`).join('');
  }

  function applyLobby(payload) {
    state.hostId = payload.hostId;
    state.lobby = { players: payload.players || [], crowd: payload.crowd || [], started: !!payload.started };
    $('setup-view').style.display = 'none';
    $('room-view').style.display = 'block';
    $('room-code-txt').textContent = payload.roomCode;
    ['intro-vo', 'final-round-vo', 'explosion'].forEach(loadSample);
    $('lobby-card').classList.toggle('link-room', state.linkRoom);
    renderSlots();
    const count = state.lobby.players.length;
    const host = everyone().find((m) => m.id === state.hostId);
    const enough = count >= MIN_PLAYERS;
    $('start-btn').textContent = !enough ? `Need ${MIN_PLAYERS - count} more player${MIN_PLAYERS - count === 1 ? '' : 's'}` : count === 1 ? 'Start solo' : `Start with ${count} players`;
    $('start-btn').disabled = !enough;
    $('start-btn').style.display = isHost() && !state.lobby.started ? 'block' : 'none';
    $('rejoin-btn').style.display = state.lobby.started && state.away ? 'block' : 'none';
    let wait = '';
    if (state.lobby.started) wait = state.away ? 'A game is on right now.' : '';
    else if (!isHost()) wait = `Waiting for ${host ? host.name : 'the host'} to start...`;
    if (!state.lobby.started && me() && me().role === 'crowd') wait = `You're in the crowd: you'll vote on every matchup. ${wait}`;
    $('wait-msg').textContent = wait;
    $('room-code-txt').classList.toggle('long', payload.roomCode.length > 6);
    $('share-link').value = shareLink(payload.roomCode);
    history.replaceState(null, '', `${basePath()}?room=${encodeURIComponent(payload.roomCode.toLowerCase())}`);
    if (state.game) renderChips();
    updateResultsButtons();
  }

  function showLobby() {
    clearGameScreens();
    hush();
    $('game-view').style.display = 'none';
    $('lobby-card').style.display = 'block';
    document.body.classList.remove('in-game');
  }
  function enterGame() {
    $('lobby-card').style.display = 'none';
    $('game-view').style.display = 'flex';
    document.body.classList.add('in-game');
  }
  // Directory the game is served from, e.g. "/decimates/" on GitHub Pages or "/" locally.
  const basePath = () => location.pathname.replace(/[^/]*$/, '');
  const shareLink = (roomCode) => `${location.origin}${basePath()}${roomCode.toLowerCase()}`;

  function resetToSetup() {
    history.replaceState(null, '', basePath());
    state.linkRoom = false;
    $('lobby-card').classList.remove('link-room');
    state.playerId = null;
    state.hostId = null;
    state.lobby = { players: [], crowd: [], started: false };
    state.game = null;
    state.phase = null;
    state.away = false;
    renderSlots();
    $('room-view').style.display = 'none';
    $('setup-view').style.display = 'block';
    showLobby();
  }
  function setConnecting(connecting) {
    if (connecting) showError('');
    $('connecting-hint').textContent = 'Connecting...';
    $('connecting-hint').style.display = connecting ? 'block' : 'none';
  }
  function handleJoinResponse(res) {
    setConnecting(false);
    if (!res.ok) {
      if (state.linkRoom || $('room-view').style.display === 'block') resetToSetup();
      return showError(res.error);
    }
    showError('');
    state.playerId = res.playerId;
    applyLobby(res);
  }

  // ---------- Your name ----------
  // Everyone picks their name in a pop-up when creating, joining or opening a room link (filled in with the
  // last one used on this device).
  const NAME_KEY = 'decimates-name';
  function savedName() {
    try { return Engine.sanitizeName(localStorage.getItem(NAME_KEY) || ''); } catch { return ''; }
  }
  function saveName(name) {
    const clean = Engine.sanitizeName(name);
    try { localStorage.setItem(NAME_KEY, clean); } catch { /* private mode */ }
    net.setName(clean);
    return clean;
  }
  net.setName(savedName());
  let afterName = null;
  function withName(then) {
    afterName = then;
    $('name-modal-input').value = savedName();
    $('name-overlay').classList.add('show');
    setTimeout(() => { $('name-modal-input').focus(); $('name-modal-input').select(); }, 50);
  }
  function cancelName() {
    afterName = null;
    $('name-overlay').classList.remove('show');
  }
  $('name-overlay').addEventListener('click', (e) => { if (e.target === $('name-overlay')) cancelName(); });
  $('name-modal-input').addEventListener('keydown', (e) => { if (e.key === 'Escape') cancelName(); });
  $('name-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = Engine.sanitizeName($('name-modal-input').value);
    if (!name) return $('name-modal-input').focus();
    saveName(name);
    $('name-overlay').classList.remove('show');
    const then = afterName;
    afterName = null;
    if (then) then();
  });

  $('create-btn').addEventListener('click', () => withName(() => {
    setConnecting(true);
    net.emit('createRoom', handleJoinResponse);
  }));
  $('join-btn').addEventListener('click', () => {
    const code = $('room-input').value.trim().toUpperCase();
    if (!/^[A-Z]{4}$/.test(code)) return showError('Enter a 4-letter room code.');
    withName(() => {
      setConnecting(true);
      net.emit('joinRoom', code, handleJoinResponse);
    });
  });
  $('room-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('join-btn').click(); });

  // Menu sounds on the home screen, lobby and name prompt.
  const UI_TARGETS = '.btn';
  ['lobby-card', 'name-overlay'].forEach((id) => {
    const root = $(id);
    let hovered = null;
    root.addEventListener('pointerover', (e) => {
      const el = e.target.closest(UI_TARGETS);
      if (el === hovered) return;
      hovered = el;
      if (el && !el.disabled && e.pointerType === 'mouse') playSfx('uiHover');
    });
    root.addEventListener('pointerleave', () => { hovered = null; });
    root.addEventListener('click', (e) => {
      const el = e.target.closest(UI_TARGETS);
      if (el && !el.disabled) playSfx('uiClick');
    });
  });

  $('start-btn').addEventListener('click', () => {
    getAudioCtx();
    net.emit('startGame', startOptions());
  });
  $('again-btn').addEventListener('click', () => {
    getAudioCtx();
    net.emit('startGame', startOptions());
  });
  $('rejoin-btn').addEventListener('click', () => {
    getAudioCtx();
    state.away = false;
    $('rejoin-btn').style.display = 'none';
    enterGame();
    renderChips();
    if (state.phase) applyPhase(state.phase, true);
  });
  $('leave-btn').addEventListener('click', () => {
    net.emit('leaveRoom');
    resetToSetup();
  });
  $('exit-btn').addEventListener('click', () => {
    state.over = null;
    showLobby();
    applyLobby({ ...state.lobby, hostId: state.hostId, roomCode: $('room-code-txt').textContent });
  });
  // Home: back to the lobby (still in the room; the show goes on until you press "Back to the show").
  $('game-home').addEventListener('click', () => {
    state.away = !!state.lobby.started;
    showLobby();
    $('rejoin-btn').style.display = state.away ? 'block' : 'none';
  });
  $('home-btn').addEventListener('click', () => {
    net.emit('leaveRoom');
    resetToSetup();
  });

  net.on('lobbyUpdate', (payload) => applyLobby(payload));
  net.on('disconnect', (reason) => {
    resetToSetup();
    showError(reason || 'Disconnected.');
  });
  net.on('status', (text) => {
    if ($('connecting-hint').style.display === 'block') $('connecting-hint').textContent = text;
    if ($('reconnect-hint').style.display === 'block') $('reconnect-hint').textContent = text;
  });
  net.on('reconnecting', (message) => {
    state.game = null;
    state.phase = null;
    state.away = false;
    showLobby();
    $('start-btn').style.display = 'none';
    $('rejoin-btn').style.display = 'none';
    showError('');
    $('reconnect-hint').textContent = message;
    $('reconnect-hint').style.display = 'block';
  });
  net.on('rejoined', (res) => {
    $('reconnect-hint').style.display = 'none';
    handleJoinResponse(res);
  });

  $('copy-btn').addEventListener('click', async () => {
    const input = $('share-link');
    try {
      await navigator.clipboard.writeText(input.value);
    } catch {
      input.select();
      document.execCommand('copy');
    }
    $('copy-btn').textContent = 'Copied!';
    setTimeout(() => { $('copy-btn').textContent = 'Copy link'; }, 1500);
  });

  // Apps that embed the game pass their own session id as ?group=<id>; it's hashed into a 4-letter code.
  const GROUP_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  function groupRoom(id) {
    if (!id) return null;
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < id.length; i++) {
      const ch = id.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    let hash = 4294967296 * (2097151 & h2) + (h1 >>> 0);
    let code = '';
    for (let i = 0; i < 4; i++) {
      code += GROUP_LETTERS[hash % GROUP_LETTERS.length];
      hash = Math.floor(hash / GROUP_LETTERS.length);
    }
    return code;
  }
  // Links like /decimates/mate (or ?room=mate) open that room: join it if someone is hosting, otherwise host it.
  function enterRoomFromUrl() {
    const requested = PARAMS.get('room') || groupRoom(PARAMS.get('group'));
    if (!requested) return;
    if (!window.DecimatesNet.normaliseRoomName(requested)) {
      history.replaceState(null, '', basePath());
      return showError('Room names are 2-16 letters, numbers or dashes.');
    }
    state.linkRoom = true;
    $('lobby-card').classList.add('link-room');
    withName(() => {
      setConnecting(true);
      net.emit('enterRoom', requested, handleJoinResponse);
    });
  }

  // ---------- Game: phases from the host ----------

  net.on('gameStarted', (payload) => {
    state.away = false;
    state.over = null;
    state.game = { order: payload.order, totals: payload.totals || [] };
    applyLobby(payload);
    $('reconnect-hint').style.display = 'none';
    enterGame();
    renderChips();
    applyPhase(payload);
  });
  net.on('phase', (p) => {
    if (!state.game) return;
    applyPhase(p);
  });
  net.on('gameOver', (over) => {
    state.over = over;
    state.phase = { phase: 'results' };
    state.lobby.started = false;
    if (state.away) return;
    showResults(over);
  });

  function hideOverlays() {
    document.querySelectorAll('#game-view .overlay').forEach((o) => o.classList.remove('show'));
  }
  // Everything game-screen goes away (back to the lobby, or between screens).
  function clearGameScreens() {
    hideOverlays();
    hideWrite();
    hideMatchup();
    hideIntro();
  }

  function applyPhase(p, force = false) {
    const prev = state.phase;
    state.phase = p;
    if (state.game && p.totals) state.game.totals = p.totals;
    if (state.away) return;
    renderChips();
    if (p.phase === 'results') {
      if (state.over) showResults(state.over);
      return;
    }
    if (p.phase === 'intro') {
      hideWrite();
      hideMatchup();
      hideOverlays();
      showIntro(p);
      return;
    }
    hideIntro();
    if (p.phase === 'write') {
      hideMatchup();
      hideOverlays();
      showWrite(p);
      return;
    }
    hideWrite();
    if (p.phase === 'matchup') {
      hideOverlays();
      showMatchup(p, prev, force);
      return;
    }
    if (p.phase === 'standings') {
      hideMatchup();
      showStandings(p);
    }
  }

  function renderChips() {
    const chips = $('chips');
    if (!state.game) return chips.replaceChildren();
    const totals = new Map((state.game.totals || []).map((t) => [t.id, t.total]));
    const players = state.lobby.players.filter((p) => totals.has(p.id) || (state.game.order || []).includes(p.id));
    chips.classList.toggle('many', players.length > 4);
    chips.replaceChildren(...players.map((p) => {
      const chip = document.createElement('div');
      chip.className = 'chip-p';
      chip.style.setProperty('--pc', p.color);
      chip.innerHTML = `${avatarImg(p.name, 'chip-av')}<span class="name">${esc(p.name)}${p.id === state.playerId ? ' (you)' : ''}</span><span class="score">${totals.get(p.id) || 0}</span>`;
      return chip;
    }));
    const crowd = state.lobby.crowd.length;
    if (crowd) {
      const chip = document.createElement('div');
      chip.className = 'chip-p crowd';
      chip.innerHTML = `<span class="dot">👥</span><span>Crowd: ${crowd}</span>`;
      chips.append(chip);
    }
  }

  // ---------- Intros: how to play (start of the game) and the final round, over their voiceovers ----------
  // `at` is when each line appears (seconds in), lined up with the pauses in the voiceover.
  const INTROS = {
    rules: {
      sound: 'intro-vo',
      kicker: 'How to play',
      title: 'Decimates',
      rules: [
        [6.4, "You'll get a series of goofy prompts."],
        [9.2, 'Type whatever will tickle the most funny bones.'],
        [13.0, 'Your answers go head to head, and everyone else votes for their favourite.'],
        [19.3, 'Decimate the room to win the round.'],
        [22.5, 'No wrong answers... just bad jokes.'],
      ],
      cta: [25.8, '90 seconds on the clock. Ready?'],
    },
    final: {
      sound: 'final-round-vo',
      kicker: 'Round 3',
      title: 'The final round',
      rules: (p) => [
        [2.6, p.comicFinal ? 'Everyone captions the exact same comic.' : 'Everyone gets the exact same prompt.'],
        [5.2, 'All the answers go up together for the last laugh of the game.'],
        [8.0, 'Vote for up to 3 favourites (not your own).'],
        [10.2, 'Every vote is worth triple points.'],
      ],
      cta: [12.6, 'Off you trot: go light some fuses.'],
    },
  };
  let intro = null;
  function showIntro(p) {
    const kind = INTROS[p.introKind] ? p.introKind : 'rules';
    const def = INTROS[kind];
    const key = `${kind}:${p.introStartedAt}`;
    $('intro-skip').hidden = !isHost();
    $('intro-overlay').classList.add('show');
    if (intro && intro.key === key) return;
    hideIntro();
    $('intro-overlay').classList.add('show');
    $('intro-kicker').textContent = def.kicker;
    $('intro-title').textContent = def.title;
    const rules = typeof def.rules === 'function' ? def.rules(p) : def.rules;
    const elapsed = Math.max(0, (net.hostNow() - p.introStartedAt) / 1000);
    const total = Math.max(0.1, (p.introEndsAt - p.introStartedAt) / 1000);
    $('intro-rules').innerHTML = rules.map(([at, text]) => `<li style="animation-delay:${Math.max(0, at - elapsed).toFixed(2)}s">${esc(text)}</li>`).join('');
    $('intro-cta').textContent = def.cta[1];
    $('intro-cta').style.animationDelay = `${Math.max(0, def.cta[0] - elapsed).toFixed(2)}s`;
    const bar = $('intro-progress');
    bar.style.transition = 'none';
    bar.style.width = `${Math.min(100, (elapsed / total) * 100)}%`;
    void bar.offsetWidth;
    bar.style.transition = `width ${Math.max(0, total - elapsed).toFixed(2)}s linear`;
    bar.style.width = '100%';
    intro = { key, src: null, gain: null };
    const mine = intro;
    hush();
    loadSample(def.sound).then((buf) => {
      const a = getAudioCtx();
      if (intro !== mine || !buf || !a) return;
      // Late joiners (and a slow decode) pick the voiceover up at the right point.
      const offset = Math.max(0, (net.hostNow() - p.introStartedAt) / 1000);
      if (offset >= buf.duration - 0.3) return;
      const src = a.createBufferSource();
      src.buffer = buf;
      const g = a.createGain();
      g.gain.value = 1.15;
      src.connect(g).connect(sfxGain);
      src.start(a.currentTime + 0.02, offset);
      mine.src = src;
      mine.gain = g;
    });
  }
  function hideIntro() {
    $('intro-overlay').classList.remove('show');
    if (!intro) return;
    const { src, gain } = intro;
    if (src && ac) {
      const n = ac.currentTime;
      gain.gain.setValueAtTime(gain.gain.value, n);
      gain.gain.linearRampToValueAtTime(0.0001, n + 0.25);
      try { src.stop(n + 0.3); } catch { /* already stopped */ }
    }
    intro = null;
  }
  $('intro-skip').addEventListener('click', () => {
    $('intro-skip').disabled = true;
    net.emit('input', { type: 'skipIntro' });
    setTimeout(() => { $('intro-skip').disabled = false; }, 1500);
  });

  // ---------- Writing ----------
  const write = { key: null, done: false, saved: false, answers: {}, timers: {}, lastTick: null, clock: null };

  function writersOf(p) { return p.writers || []; }

  function showWrite(p) {
    $('write-view').hidden = false;
    const mine = writersOf(p).find((w) => w.id === state.playerId);
    const key = `${state.game && state.game.order.join()}:${p.round}:${p.writeEndsAt - p.writeMs}`;
    if (write.key !== key) {
      write.key = key;
      write.answers = {};
      write.done = !!(mine && mine.done);
      write.saved = write.done;
      write.lastTick = null;
      Object.values(write.timers).forEach((t) => clearTimeout(t));
      write.timers = {};
      if (mine) buildWriteForm(mine.prompts, p.final);
      playSfx('whistle');
    }
    const final = p.final ? ' · the final' : '';
    $('write-round').innerHTML = `Round <b>${p.round}</b> / ${p.rounds}${final}`;
    $('write-form').hidden = !mine;
    $('write-watch').hidden = !!mine;
    $('watch-kicker').textContent = p.final ? 'The final' : `Round ${p.round}`;
    renderWriteState();
    renderWriters();
    clearInterval(write.clock);
    updateWriteClock();
    write.clock = setInterval(updateWriteClock, 200);
  }
  function hideWrite() {
    $('write-view').hidden = true;
    clearInterval(write.clock);
    write.clock = null;
    $('write-clock').classList.remove('panic', 'fast');
  }

  function buildWriteForm(prompts, final) {
    $('write-prompts').replaceChildren(...prompts.map((q, i) => {
      const box = document.createElement('div');
      box.className = 'wp';
      const comic = q.comic ? `<figure class="wp-comic"><img src="${esc(q.comic)}" alt="A Buck Ryan comic strip to caption"><figcaption>${esc(q.note || '')}</figcaption></figure>` : '';
      box.innerHTML = `<p class="wp-label">${final ? 'The final' : `Prompt ${i + 1} of ${prompts.length}`}</p>
        <p class="wp-prompt">${esc(q.text)}</p>${comic}
        <div class="wp-row">
          <textarea class="wp-input" id="wp-${i}" rows="2" maxlength="${Engine.ANSWER_MAX}" placeholder="Your funniest answer..." autocomplete="off" autocapitalize="sentences"></textarea>
          <button type="button" class="btn small yellow wp-stock" data-i="${i}">Stock joke</button>
        </div>
        <p class="wp-count" id="wp-count-${i}">0 / ${Engine.ANSWER_MAX}</p>`;
      const input = box.querySelector('textarea');
      input.addEventListener('input', () => {
        input.value = input.value.replace(/\n/g, ' ');
        write.answers[q.id] = input.value;
        $(`wp-count-${i}`).textContent = `${input.value.length} / ${Engine.ANSWER_MAX}`;
        queueAnswer(q.id);
      });
      input.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const next = $(`wp-${i + 1}`);
        if (next) next.focus();
        else input.blur();
      });
      box.querySelector('.wp-stock').addEventListener('click', () => {
        if (write.done) return;
        input.value = Prompts.stockJoke();
        input.dispatchEvent(new Event('input'));
        playSfx('boing');
      });
      return box;
    }));
  }
  function sendAnswer(promptId) {
    clearTimeout(write.timers[promptId]);
    delete write.timers[promptId];
    net.emit('input', { type: 'answer', promptId, text: write.answers[promptId] || '' });
  }
  function queueAnswer(promptId) {
    if (write.done) return;
    clearTimeout(write.timers[promptId]);
    write.timers[promptId] = setTimeout(() => sendAnswer(promptId), 300);
  }
  function flushAnswers() {
    Object.keys(write.answers).forEach((id) => sendAnswer(/^\d+$/.test(id) ? Number(id) : id));
  }

  function renderWriteState() {
    document.querySelectorAll('#write-prompts textarea, #write-prompts .wp-stock').forEach((el) => { el.disabled = write.done; });
    $('write-done').disabled = write.done;
    $('write-done').textContent = write.done ? 'Locked in ✓' : write.saved ? 'Save and lock in' : 'Light the fuse';
    $('write-edit').hidden = !write.done;
  }
  function renderWriters() {
    const p = state.phase;
    if (!p || p.phase !== 'write') return;
    const writers = writersOf(p);
    $('writers').innerHTML = writers.map((w) => `<span class="writer${w.done ? ' done' : ''}" style="--pc:${w.color}">${avatarImg(w.name, 'chip-av')}${esc(w.id === state.playerId ? 'You' : w.name)}</span>`).join('');
    const left = writers.filter((w) => !w.done).length;
    $('write-status').textContent = write.done ? (left ? `Locked in. Waiting for ${left} more...` : 'Locked in!') : '';
  }
  $('write-done').addEventListener('click', () => {
    const p = state.phase;
    if (write.done || !p || p.phase !== 'write') return;
    flushAnswers();
    write.done = true;
    write.saved = true;
    net.emit('input', { type: 'done' });
    playSfx('submit');
    renderWriteState();
    renderWriters();
  });
  $('write-edit').addEventListener('click', () => {
    const p = state.phase;
    if (!write.done || !p || p.phase !== 'write') return;
    write.done = false;
    net.emit('input', { type: 'edit' });
    renderWriteState();
    renderWriters();
    const first = $('wp-0');
    if (first) first.focus();
  });

  // The clock: red and pulsing from 10 seconds, with a tick every second (twice a second for the last 3).
  function updateWriteClock() {
    const p = state.phase;
    if (!p || p.phase !== 'write') return;
    const msLeft = Math.max(0, p.writeEndsAt - net.hostNow());
    const secs = Math.ceil(msLeft / 1000);
    $('write-clock').textContent = secs;
    $('write-clock').classList.toggle('panic', secs <= 10 && secs > 0);
    $('write-clock').classList.toggle('fast', secs <= 3 && secs > 0);
    const mine = writersOf(p).some((w) => w.id === state.playerId);
    if (secs <= 10 && msLeft > 0) {
      const half = Math.ceil(msLeft / 500);
      const tickKey = secs <= 3 ? `h${half}` : `s${secs}`;
      if (write.lastTick !== tickKey) {
        write.lastTick = tickKey;
        playSfx('tick', secs <= 3);
      }
    }
    if (msLeft <= 0 && mine && !write.done) flushAnswers();
  }

  // ---------- Matchups ----------
  // Show: the prompt big in the middle, then it shrinks to the top; answer A and B land on dynamite.
  // Vote: tap an answer (or up to 3 in the final); voters' faces appear on the answers; the fuse burns.
  // Reveal: who wrote what and the points; the winner EXPLODES and its label flies out of the smoke.
  const mu = { key: null, step: null, timers: [], stopHiss: null, picks: new Set(), cast: false, timerRaf: null };

  function clearMuTimers() {
    mu.timers.forEach((t) => clearTimeout(t));
    mu.timers = [];
    if (mu.stopHiss) mu.stopHiss();
    mu.stopHiss = null;
  }
  function hideMatchup() {
    clearMuTimers();
    cancelAnimationFrame(mu.timerRaf);
    mu.key = null;
    mu.step = null;
    $('matchup-view').hidden = true;
    $('matchup-view').classList.remove('flying');
    clearFx();
    $('flyer').classList.remove('show');
  }
  const later = (ms, fn) => { mu.timers.push(setTimeout(fn, Math.max(0, ms))); };

  function showMatchup(p) {
    const m = p.matchup;
    if (!m) return;
    $('matchup-view').hidden = false;
    const key = `${p.round}:${m.index}`;
    const fresh = mu.key !== key;
    if (fresh) {
      clearMuTimers();
      // The last matchup's explosion, winner card and banner go before the next one starts.
      clearFx();
      $('flyer').classList.remove('show');
      $('matchup-view').classList.remove('flying');
      mu.key = key;
      mu.step = null;
      mu.picks = new Set();
      mu.cast = false;
      buildMatchup(p, m);
    }
    if (mu.step !== m.step) {
      const from = mu.step;
      mu.step = m.step;
      if (m.step === 'show') runShow(m, fresh);
      if (m.step === 'vote') runVote(m, from);
      if (m.step === 'reveal') runReveal(m);
    }
    renderVotes(m);
  }

  function buildMatchup(p, m) {
    $('mu-count').textContent = m.final ? `The final · round ${p.round}` : `Round ${p.round} · matchup ${m.index + 1} of ${m.count}`;
    $('mu-prompt-text').textContent = m.prompt;
    $('mu-comic').hidden = !m.comic;
    if (m.comic) {
      $('mu-comic-img').src = m.comic;
      $('mu-comic-note').textContent = m.note || '';
    }
    const box = $('mu-answers');
    box.classList.toggle('final', !!m.final);
    box.classList.toggle('many', m.answers.length > 4);
    box.classList.toggle('single', m.answers.length === 1);
    box.replaceChildren(...m.answers.map((a, i) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'dyn';
      el.dataset.i = i;
      el.disabled = true;
      el.innerHTML = `<span class="dyn-art">${dynamiteSvg()}
        <span class="dyn-label${a.empty ? ' empty' : ''}${a.text.length > 58 ? ' longer' : a.text.length > 34 ? ' long' : ''}"><span class="dyn-text">${esc(a.text)}</span></span>${dynamiteRopes()}</span>
        <span class="dyn-letter">${m.final ? i + 1 : 'AB'[i]}</span>
        <span class="dyn-voters"></span>
        <span class="dyn-author"></span>
        <span class="dyn-points"></span>`;
      el.addEventListener('click', () => pick(i));
      return el;
    }));
    $('mu-prompt').classList.remove('docked');
    $('mu-answers').classList.remove('voting', 'revealed');
    $('mu-cast').hidden = true;
    $('mu-help').textContent = '';
    $('mu-voted').textContent = '';
  }

  // Seconds into the current step (late joiners and reconnects pick it up part-way).
  const stepElapsed = (m) => Math.max(0, (m.stepMs - Math.max(0, m.stepEndsAt - net.hostNow())) / 1000);

  function runShow(m, fresh) {
    const t = stepElapsed(m);
    const dyns = [...document.querySelectorAll('#mu-answers .dyn')];
    dyns.forEach((d) => {
      d.classList.remove('in', 'lit', 'boom', 'dud', 'win', 'picked', 'mine');
      setFuse(d, 0);
    });
    const prompt = $('mu-prompt');
    prompt.classList.remove('docked', 'pop');
    if (t < 0.2) {
      replay(prompt, 'pop');
      playSfx('whistle');
      say(m.prompt, { cancel: true });
    }
    later((1.8 - t) * 1000, () => prompt.classList.add('docked'));
    // Answers land one after another (all together in a big final).
    const gap = m.final ? Math.min(0.45, 3.4 / dyns.length) : 1.2;
    dyns.forEach((d, i) => {
      const at = 2.2 + i * gap;
      later((at - t) * 1000, () => {
        d.classList.add('in');
        if (at - t > -0.2) {
          playSfx('boing');
        }
      });
    });
    if (!fresh && t > 1.8) prompt.classList.add('docked');
    startTimerBar(m, false);
  }

  function amAuthor(m) {
    return (m.authors || []).includes(state.playerId);
  }
  const canVote = (m) => (m.voters || []).includes(state.playerId);
  const myAnswerIndex = (m) => (m.final ? m.answers.findIndex((a) => a.authorId === state.playerId) : -1);

  function runVote(m) {
    $('mu-prompt').classList.add('docked');
    const dyns = [...document.querySelectorAll('#mu-answers .dyn')];
    dyns.forEach((d) => d.classList.add('in', 'lit'));
    $('mu-answers').classList.add('voting');
    const mine = myAnswerIndex(m);
    if (mine >= 0) dyns[mine].classList.add('mine');
    const voting = canVote(m) && !(m.voted || []).includes(state.playerId);
    dyns.forEach((d, i) => { d.disabled = !voting || i === mine; });
    if (amAuthor(m)) $('mu-help').textContent = "That's your joke up there. Sit tight while the others vote!";
    else if (!canVote(m)) $('mu-help').textContent = 'Watch the votes come in...';
    else if (m.final) $('mu-help').textContent = `Pick up to ${m.picks} favourites (not your own), then cast your votes.`;
    else $('mu-help').textContent = 'Tap the funniest one!';
    $('mu-cast').hidden = !(m.final && voting);
    $('mu-cast').disabled = true;
    const secs = Math.max(0.5, (m.stepEndsAt - net.hostNow()) / 1000);
    if (mu.stopHiss) mu.stopHiss();
    mu.stopHiss = fuseHiss(secs);
    hush();
    startTimerBar(m, true);
  }

  function pick(i) {
    const m = state.phase && state.phase.matchup;
    if (!m || m.step !== 'vote' || !canVote(m) || mu.cast) return;
    if (m.final) {
      if (mu.picks.has(i)) mu.picks.delete(i);
      else if (mu.picks.size < m.picks) mu.picks.add(i);
      document.querySelectorAll('#mu-answers .dyn').forEach((d, j) => d.classList.toggle('picked', mu.picks.has(j)));
      $('mu-cast').disabled = !mu.picks.size;
      $('mu-cast').textContent = mu.picks.size ? `Cast my ${mu.picks.size} vote${mu.picks.size > 1 ? 's' : ''}` : 'Cast my votes';
      playSfx('pop');
      return;
    }
    mu.cast = true;
    net.emit('input', { type: 'vote', matchup: m.index, choice: i === 0 ? 'a' : 'b' });
    document.querySelectorAll('#mu-answers .dyn').forEach((d, j) => {
      d.classList.toggle('picked', j === i);
      d.disabled = true;
    });
    $('mu-help').textContent = 'Vote in. Watch the fuses...';
    playSfx('pop');
  }
  $('mu-cast').addEventListener('click', () => {
    const m = state.phase && state.phase.matchup;
    if (!m || !m.final || !mu.picks.size || mu.cast) return;
    mu.cast = true;
    net.emit('input', { type: 'vote', matchup: m.index, choices: [...mu.picks] });
    document.querySelectorAll('#mu-answers .dyn').forEach((d) => { d.disabled = true; });
    $('mu-cast').hidden = true;
    $('mu-help').textContent = 'Votes in. Watch the fuses...';
    playSfx('submit');
  });

  // Voters' faces on the answers they picked (live while voting, final at the reveal).
  function renderVotes(m) {
    const dyns = [...document.querySelectorAll('#mu-answers .dyn')];
    m.answers.forEach((a, i) => {
      const box = dyns[i] && dyns[i].querySelector('.dyn-voters');
      if (!box) return;
      const ids = a.voters.map((v) => v.id).join();
      if (box.dataset.ids === ids) return;
      const before = box.dataset.ids ? box.dataset.ids.split(',').filter(Boolean).length : 0;
      box.dataset.ids = ids;
      box.innerHTML = a.voters.map((v, k) => `<span class="voter${k >= before ? ' new' : ''}" title="${esc(v.name)}">${avatarImg(v.name, '', v.color)}<b>${esc(nameOf(v))}</b></span>`).join('');
      if (a.voters.length > before && m.step === 'vote') playSfx('pop');
    });
    const voters = m.voters || [];
    $('mu-voted').textContent = m.step === 'vote' && voters.length ? `${(m.voted || []).length} of ${voters.length} voted` : '';
  }

  function startTimerBar(m, running) {
    cancelAnimationFrame(mu.timerRaf);
    const bar = $('mu-timer-bar');
    const dyns = running ? [...document.querySelectorAll('#mu-answers .dyn')] : [];
    const frame = () => {
      const left = Math.max(0, Math.min(1, (m.stepEndsAt - net.hostNow()) / m.stepMs));
      bar.style.transform = `scaleX(${running ? left : 1})`;
      // The fuses burn down with the vote clock (the last bit goes at the reveal).
      dyns.forEach((d) => setFuse(d, (1 - left) * 0.9));
      bar.parentElement.classList.toggle('low', running && left < 0.3);
      if (running && left > 0) mu.timerRaf = requestAnimationFrame(frame);
    };
    frame();
  }

  function runReveal(m) {
    clearMuTimers();
    cancelAnimationFrame(mu.timerRaf);
    $('mu-timer-bar').style.transform = 'scaleX(0)';
    $('mu-prompt').classList.add('docked');
    $('mu-cast').hidden = true;
    $('mu-help').textContent = m.practice ? 'Practice round: nobody else to vote, so no points. Invite some mates!' : '';
    $('mu-voted').textContent = '';
    $('mu-answers').classList.remove('voting');
    $('mu-answers').classList.add('revealed');
    const dyns = [...document.querySelectorAll('#mu-answers .dyn')];
    const t = stepElapsed(m);
    dyns.forEach((d, i) => {
      const a = m.answers[i];
      d.disabled = true;
      d.classList.add('in');
      d.querySelector('.dyn-author').innerHTML = a.author ? `${avatarImg(a.author.name, '', a.author.color)}<span>${esc(nameOf(a.author))}</span>` : '';
      d.querySelector('.dyn-points').textContent = m.practice ? '' : `+${a.points || 0}`;
      d.classList.toggle('win', !!a.winner);
      if (!a.winner) {
        d.classList.remove('lit');
        d.classList.add('dud');
      }
    });
    const winners = m.answers.map((a, i) => (a.winner ? i : -1)).filter((i) => i >= 0);
    if (!winners.length) {
      $('mu-help').textContent = 'Nobody voted... the fuses fizzled out.';
      if (t < 0.5) playSfx('fizzle');
      return;
    }
    if (t > 2) {
      // Joined late: skip straight to the result.
      winners.forEach((i) => dyns[i].classList.add('boom'));
      showFlyer(m, winners);
      return;
    }
    // The winning fuses burn the last bit, then they go off and the labels fly out of the smoke.
    winners.forEach((i) => {
      dyns[i].classList.add('lit');
      burnOut(dyns[i]);
    });
    if (t < 0.4) mu.stopHiss = fuseHiss(0.5);
    if (winners.length < m.answers.length) playSfx('fizzle');
    later(480 - t * 1000, () => {
      if (mu.stopHiss) mu.stopHiss();
      const labels = winners.map((i) => dyns[i].querySelector('.dyn-label'));
      const from = labels.map((l) => l.getBoundingClientRect());
      const arts = winners.map((i) => dyns[i].querySelector('.dyn-art').getBoundingClientRect());
      winners.forEach((i) => dyns[i].classList.add('boom'));
      explode(arts);
      showFlyer(m, winners, from);
    });
    if (m.cleanSweep) {
      later(1500 - t * 1000, () => {
        playSfx('win');
        confetti();
      });
    }
  }

  // ---------- The explosion ----------
  // From each winning bundle: a flash, a shockwave, sparks and bits of stick and paper, then soft smoke that
  // billows out over the screen and clears. Positions are worked out against the fx layer so page zoom
  // doesn't throw them off.
  let fxTimer = null;
  function clearFx() {
    clearTimeout(fxTimer);
    $('fx').replaceChildren();
  }
  const rand = (a, b) => a + Math.random() * (b - a);
  function explode(rects) {
    playSfx('boom');
    if (reduceMotion()) return;
    const fx = $('fx');
    clearFx();
    const box = fx.getBoundingClientRect();
    const k = fx.offsetWidth / (box.width || 1);
    const W = fx.offsetWidth;
    const H = fx.offsetHeight;
    const reach = Math.hypot(W, H);
    const add = (cls, x, y, size, frames, opts) => {
      const el = document.createElement('i');
      el.className = cls;
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      if (size) {
        el.style.width = `${size}px`;
        el.style.height = `${size}px`;
      }
      fx.append(el);
      el.animate(frames, { fill: 'both', ...opts });
      return el;
    };
    const smokeCount = Math.round((W < 640 ? 14 : 22) / Math.max(1, rects.length * 0.7));
    rects.forEach((r) => {
      const x = (r.left + r.width / 2 - box.left) * k;
      const y = (r.top + r.height / 2 - box.top) * k;
      const s = r.width * k;
      add('fx-flash', x, y, s * 1.5, [
        { transform: 'translate(-50%,-50%) scale(.15)', opacity: 1 },
        { transform: 'translate(-50%,-50%) scale(1)', opacity: 0.95, offset: 0.25 },
        { transform: 'translate(-50%,-50%) scale(1.5)', opacity: 0 },
      ], { duration: 650, easing: 'cubic-bezier(.2,.7,.3,1)' });
      add('fx-ring', x, y, s * 0.6, [
        { transform: 'translate(-50%,-50%) scale(.2)', opacity: 0.9 },
        { transform: 'translate(-50%,-50%) scale(4.5)', opacity: 0 },
      ], { duration: 900, easing: 'cubic-bezier(.1,.8,.2,1)' });
      for (let i = 0; i < 5; i++) {
        const a = rand(0, Math.PI * 2);
        const d = rand(0, s * 0.25);
        add('fx-fire', x + Math.cos(a) * d, y + Math.sin(a) * d, s * rand(0.35, 0.6), [
          { transform: 'translate(-50%,-50%) scale(.1)', opacity: 1 },
          { transform: 'translate(-50%,-50%) scale(1)', opacity: 1, offset: 0.35 },
          { transform: `translate(-50%,-50%) translateY(${-rand(20, 60)}px) scale(1.3)`, opacity: 0 },
        ], { duration: rand(700, 1000), delay: rand(0, 120), easing: 'cubic-bezier(.2,.8,.3,1)' });
      }
      for (let i = 0; i < 18; i++) {
        const a = (i / 18) * Math.PI * 2 + rand(-0.15, 0.15);
        const d = rand(s * 0.6, s * 1.4);
        add('fx-spark', x, y, 0, [
          { transform: `translate(-50%,-50%) rotate(${a}rad) translateX(${s * 0.1}px) scaleX(.4)`, opacity: 1 },
          { transform: `translate(-50%,-50%) rotate(${a}rad) translateX(${d}px) scaleX(1)`, opacity: 0 },
        ], { duration: rand(450, 750), easing: 'cubic-bezier(.1,.7,.3,1)' });
      }
      for (let i = 0; i < 12; i++) {
        const a = rand(-Math.PI * 0.95, -Math.PI * 0.05);
        const v = rand(s * 0.5, s * 1.3);
        const dx = Math.cos(a) * v;
        const dy = Math.sin(a) * v;
        const spin = rand(-540, 540);
        add(i % 3 ? 'fx-bit' : 'fx-bit paper', x, y, 0, [
          { transform: 'translate(-50%,-50%) translate(0,0) rotate(0deg)', opacity: 1 },
          { transform: `translate(-50%,-50%) translate(${dx}px,${dy}px) rotate(${spin / 2}deg)`, opacity: 1, offset: 0.45 },
          { transform: `translate(-50%,-50%) translate(${dx * 1.5}px,${dy + H * 0.5}px) rotate(${spin}deg)`, opacity: 0 },
        ], { duration: rand(1100, 1600), easing: 'cubic-bezier(.25,.6,.6,1)' });
      }
      for (let i = 0; i < smokeCount; i++) {
        const a = (i / smokeCount) * Math.PI * 2 + rand(-0.3, 0.3);
        const d = rand(0.18, 0.5) * reach;
        const dx = Math.cos(a) * d;
        const dy = Math.sin(a) * d * 0.8 - rand(20, 80);
        add('fx-smoke', x, y, rand(0.22, 0.36) * reach, [
          { transform: 'translate(-50%,-50%) translate(0,0) scale(.15)', opacity: 0 },
          { transform: `translate(-50%,-50%) translate(${dx * 0.45}px,${dy * 0.45}px) scale(.85)`, opacity: 0.92, offset: 0.25 },
          { transform: `translate(-50%,-50%) translate(${dx * 0.75}px,${dy * 0.75}px) scale(1.15)`, opacity: 0.75, offset: 0.6 },
          { transform: `translate(-50%,-50%) translate(${dx}px,${dy - 40}px) scale(1.4)`, opacity: 0 },
        ], { duration: rand(2600, 3400), delay: rand(60, 220), easing: 'cubic-bezier(.16,1,.3,1)' });
      }
    });
    // Shake the matchup, not #game-view: a transform there would make the fixed fx layer and flyer relative to
    // it (clipping them to its width) until the shake ended.
    $('matchup-view').animate([
      { transform: 'translate(0,0)' }, { transform: 'translate(-6px,3px)' }, { transform: 'translate(5px,-4px)' },
      { transform: 'translate(-3px,2px)' }, { transform: 'translate(2px,-1px)' }, { transform: 'translate(0,0)' },
    ], { duration: 420, easing: 'ease-out' });
    fxTimer = setTimeout(clearFx, 4000);
  }

  // The winning label flies from the bundle, through the smoke, to the middle of the screen; then who wrote
  // it and the points. from: where each label was on its bundle (screen rects), to animate from.
  function showFlyer(m, winners, from) {
    const flyer = $('flyer');
    const cards = winners.map((i) => {
      const a = m.answers[i];
      const pts = m.practice ? '' : ` <b>+${a.points || 0}</b>`;
      return `<div class="fly-card"><span class="dyn-label"><span class="dyn-text">${esc(a.text)}</span></span>
        <span class="fly-by">${a.author ? `${avatarImg(a.author.name, '', a.author.color)}${esc(nameOf(a.author))}` : ''}${pts}</span></div>`;
    }).join('');
    const kicker = m.practice ? 'Practice round'
      : m.cleanSweep ? `Clean sweep! +${Engine.CLEAN_SWEEP_BONUS} bonus`
        : winners.length > 2 ? `A ${winners.length}-way tie` : winners.length > 1 ? "It's a tie" : 'The winner';
    flyer.innerHTML = `<p class="fly-kicker${m.cleanSweep ? ' sweep' : ''}">${kicker}</p>${cards}`;
    flyer.classList.toggle('multi', winners.length > 1);
    flyer.classList.remove('show', 'animate');
    $('matchup-view').classList.add('flying');
    void flyer.offsetWidth;
    flyer.classList.add('show');
    if (!from || reduceMotion()) return;
    flyer.classList.add('animate');
    const box = flyer.getBoundingClientRect();
    const k = flyer.offsetWidth / (box.width || 1);
    flyer.querySelectorAll('.fly-card .dyn-label').forEach((lab, j) => {
      const a = from[j];
      if (!a) return;
      const b = lab.getBoundingClientRect();
      const dx = (a.left + a.width / 2 - (b.left + b.width / 2)) * k;
      const dy = (a.top + a.height / 2 - (b.top + b.height / 2)) * k;
      const sc = a.width / (b.width || 1);
      lab.animate([
        { transform: `translate(${dx}px,${dy}px) scale(${sc}) rotate(-2deg)` },
        { transform: `translate(${dx * 0.35}px,${dy * 0.35 - 40}px) scale(${(sc + 1.1) / 2}) rotate(4deg)`, offset: 0.4 },
        { transform: 'translate(0,-8px) scale(1.04) rotate(-2.5deg)', offset: 0.8 },
        { transform: 'translate(0,0) scale(1) rotate(-1.5deg)' },
      ], { duration: 1100, easing: 'cubic-bezier(.3,.7,.2,1)', fill: 'backwards' });
    });
  }

  // ---------- Scoreboard ----------
  let nextRoundTimer = null;
  function showStandings(p) {
    const last = p.round >= p.rounds;
    $('standings-kicker').textContent = `Round ${p.round} of ${p.rounds}`;
    $('standings-title').textContent = last ? 'Final scores' : 'Scoreboard';
    $('standings-table').innerHTML = p.roundResults.map((r, i) => `<div class="standing" style="--pc:${r.color};animation-delay:${0.08 * i}s">`
      + `<span class="pl">${i + 1}</span>${avatarImg(r.name, 'st-av', r.color)}<span class="nm">${esc(r.id === state.playerId ? `${r.name} (You)` : r.name)}</span>`
      + `<span class="gain">+${r.gained}</span><span class="tot">${r.total}</span></div>`).join('');
    $('standings-next').textContent = last ? 'And the winner is...' : (p.round + 1 === p.rounds ? 'Next up: the final!' : `Round ${p.round + 1} is next: fresh prompts.`);
    renderNextRound(p);
    $('standings-overlay').classList.add('show');
  }
  function renderNextRound(p) {
    const box = $('next-round');
    const between = p.round < p.rounds && Array.isArray(p.nextPlayers);
    box.hidden = !between;
    clearInterval(nextRoundTimer);
    if (!between) return;
    const amPlayer = p.nextPlayers.includes(state.playerId);
    const ready = p.nextReady || [];
    const imIn = ready.includes(state.playerId);
    const btn = $('next-round-btn');
    btn.hidden = !amPlayer;
    btn.disabled = imIn;
    btn.textContent = imIn ? "You're in ✓" : 'Play next round';
    const tick = () => {
      if (state.phase !== p) return clearInterval(nextRoundTimer);
      const secs = Math.max(0, Math.ceil((p.standingsEndsAt - net.hostNow()) / 1000));
      const waiting = p.nextPlayers.length - ready.length;
      const who = `${ready.length} of ${p.nextPlayers.length} in`;
      $('next-round-status').innerHTML = amPlayer && !imIn
        ? `${who} · <b>${secs}s</b> to opt in, or you sit out the rest`
        : `${who} · starts in <b>${secs}s</b>${waiting ? ` or when the other ${waiting === 1 ? 'player is' : `${waiting} players are`} in` : ''}`;
    };
    tick();
    nextRoundTimer = setInterval(tick, 250);
  }
  $('next-round-btn').addEventListener('click', () => {
    const p = state.phase;
    if (!p || p.phase !== 'standings') return;
    $('next-round-btn').disabled = true;
    net.emit('input', { type: 'nextRound', round: p.round });
    playSfx('submit');
  });

  // ---------- Results ----------
  function updateResultsButtons() {
    $('again-btn').style.display = isHost() ? 'block' : 'none';
    const host = everyone().find((m) => m.id === state.hostId);
    $('results-wait').textContent = isHost() ? '' : `${host ? host.name : 'The host'} can start another game.`;
  }
  function showResults({ standings, winnerIds }) {
    clearGameScreens();
    const winners = standings.filter((r) => winnerIds.includes(r.id));
    let title = standings.length === 1 ? 'Practice over. Invite some mates to score points!' : 'Nobody scored... what a dud!';
    if (winners.length === 1) title = winners[0].id === state.playerId ? 'You blew up the competition!' : `${winners[0].name} blew up the competition!`;
    else if (winners.length > 1) title = `It's a tie! ${winners.map((w) => nameOf(w)).join(' & ')} share the glory!`;
    $('results-title').textContent = title;
    const places = standings.map((r, i) => (i && r.total === standings[i - 1].total ? null : i + 1));
    for (let i = 1; i < places.length; i++) if (places[i] === null) places[i] = places[i - 1];
    const ranked = standings.map((r, i) => ({ ...r, place: places[i] }));
    const display = ranked.length >= 2 ? [ranked[1], ranked[0], ...ranked.slice(2)] : ranked;
    const HEIGHTS = { 1: 150, 2: 112, 3: 84, 4: 62 };
    $('podium').classList.toggle('many', display.length > 4);
    $('podium').replaceChildren(...display.map((r, i) => {
      const step = document.createElement('div');
      step.className = 'step';
      step.style.setProperty('--pc', r.color);
      step.style.animationDelay = `${0.15 * (display.length - i)}s`;
      step.innerHTML = `<span class="avatar">${avatarImg(r.name, r.place === 1 ? 'hello' : '')}</span><span class="who">${esc(nameOf(r))}</span>`
        + `<div class="block" style="height:${HEIGHTS[r.place] || 60}px"><span class="place">${r.place}</span><span class="avg">${r.total}</span></div>`;
      return step;
    }));
    updateResultsButtons();
    $('results-overlay').classList.add('show');
    if (winners.length) {
      confetti();
      playSfx('win');
    }
  }

  function confetti(emoji) {
    const box = $('confetti');
    if (reduceMotion()) return;
    const colours = ['#e04a35', '#ffc94a', '#fffdf8', '#f08a24', '#7cc6a4'];
    for (let i = 0; i < (emoji ? 60 : 140); i++) {
      const c = document.createElement('div');
      c.className = emoji ? 'confetto emoji' : 'confetto';
      c.style.left = `${Math.random() * 100}%`;
      if (emoji) c.textContent = emoji[i % emoji.length];
      else c.style.background = colours[i % colours.length];
      c.style.setProperty('--dx', `${(Math.random() - 0.5) * 300}px`);
      c.style.setProperty('--rot', `${Math.random() * 1440 - 720}deg`);
      c.style.animationDuration = `${2.4 + Math.random() * 2.2}s`;
      c.style.animationDelay = `${Math.random() * 0.8}s`;
      if (!emoji && Math.random() < 0.4) { c.style.width = '8px'; c.style.height = '8px'; c.style.borderRadius = '50%'; }
      box.append(c);
    }
    setTimeout(() => box.replaceChildren(), 5600);
  }

  if (DEBUG) window.__decimatesDebug = { state, net, getAudioCtx, explode, showFlyer, mu, samples, fuseHiss, get intro() { return intro; } };

  buildSlots();
  renderSlots();
  enterRoomFromUrl();
})();
