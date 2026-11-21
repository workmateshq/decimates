(() => {
  const net = window.RapmatesNet.createNet();
  const { localNow } = window.RapmatesNet;
  const Engine = window.RapmatesEngine;
  const Words = window.RapmatesWords;
  const Beats = window.RapmatesBeats;
  const Tracks = window.RapmatesTracks;
  const PARAMS = new URLSearchParams(location.search);
  const DEBUG = PARAMS.has('debug');
  const DEBUG_CLICK = DEBUG && PARAMS.has('click'); // ?debug&click: a metronome over the track
  const COUNT_IN = Engine.COUNT_IN_BEATS;
  const BARS = Engine.BARS;
  const BPB = Engine.BEATS_PER_BAR;
  const TOTAL_BEATS = BARS * BPB;
  const COUNT_WORDS = ['8', '7', '6', '5', '4', '3', '2', '1'];
  const WB_LINES = Engine.WB_LINES;
  const LINE_BEATS = Engine.WB_BARS_PER_LINE * BPB; // a Write Bars line lasts 2 bars
  const MODE_LABELS = { writebars: 'Write Bars', freestyle: 'Freestyle' };
  // ?debug&write=10: a 10-second write timer for testing (the default is 60).
  const DEBUG_WRITE = DEBUG && PARAMS.has('write') ? Number(PARAMS.get('write')) || undefined : undefined;
  const startOptions = () => (DEBUG_WRITE ? { writeSeconds: DEBUG_WRITE } : undefined);
  const SOLO_LEAD_MS = 800;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const state = {
    playerId: null,
    hostId: null,
    linkRoom: false, // entered via a link like /rapmates/mate: no room code UI
    lobby: { players: [], crowd: [], started: false, mode: Engine.DEFAULT_MODE },
    game: null, // { round, order, results }
    phase: null, // the latest phase payload from the host
    over: null, // the latest results
    away: false, // pressed Home mid-game: still in the room, not watching
    solo: null, // { name, lastTrackId } in solo practice
    myVote: 0,
    voted: false,
  };

  // ---------- Sound ----------
  // One AudioContext: the beat goes through the music gain, effects through the sfx gain.

  let ac = null;
  let sfxGain = null;
  let musicGain = null;
  let duckGain = null; // dips the music while the robot voice raps
  const soundPrefs = (() => {
    const read = (k) => { try { return localStorage.getItem(`rapmates-${k}`) !== 'off'; } catch { return true; } };
    return { music: read('music'), sfx: read('sfx') };
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
      musicGain = ac.createGain();
      duckGain = ac.createGain();
      sfxGain.connect(comp);
      musicGain.connect(duckGain).connect(comp);
      applySoundPrefs();
      ac.addEventListener('statechange', () => {
        if (ac.state === 'running' && stage.turn) anchorAudio();
        updateNudge();
      });
    }
    if (ac.state === 'suspended') ac.resume().catch(() => {});
    return ac;
  }
  // Browsers only allow audio after a user gesture.
  ['pointerdown', 'keydown'].forEach((ev) => window.addEventListener(ev, () => { if (!ac || ac.state !== 'running') getAudioCtx(); }, true));

  // Where the speakers are right now in audio time (smooth, between the audio thread's updates).
  function audioNow() {
    if (ac.getOutputTimestamp) {
      const ts = ac.getOutputTimestamp();
      if (ts && ts.performanceTime) return ts.contextTime + (performance.now() - ts.performanceTime) / 1000;
    }
    return ac.currentTime - (ac.outputLatency || ac.baseLatency || 0);
  }

  function env(t, peak, attack, decay, dest = sfxGain) {
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    g.connect(dest);
    return g;
  }
  function tone(t, type, f0, f1, dur, peak, attack = 0.005) {
    const o = ac.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    o.connect(env(t, peak, attack, dur));
    o.start(t);
    o.stop(t + attack + dur + 0.05);
    return o;
  }
  let noiseBuf = null;
  function noise(t, dur, type, freq, peak, q = 1) {
    if (!noiseBuf) {
      noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const src = ac.createBufferSource();
    src.buffer = noiseBuf;
    const f = ac.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    src.connect(f).connect(env(t, peak, 0.003, dur));
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.05);
  }

  const sfx = {
    // Woodblock count-in click; the GO beat is higher.
    count(t, go) {
      tone(t, 'sine', go ? 1760 : 1175, go ? 1760 : 1175, 0.08, 0.5, 0.001);
      tone(t, 'triangle', go ? 880 : 587, go ? 880 : 587, 0.05, 0.25, 0.001);
    },
    // Write Bars panic ticker: a clock tick, louder and higher in the last 3 seconds.
    tick(t, urgent) {
      tone(t, 'square', urgent ? 1650 : 1250, urgent ? 1650 : 1250, 0.035, urgent ? 0.32 : 0.16, 0.001);
      tone(t, 'triangle', urgent ? 820 : 620, urgent ? 820 : 620, 0.05, urgent ? 0.3 : 0.15, 0.001);
    },
    // Debug metronome: accent on bar downbeats.
    click(t, accent) {
      tone(t, 'square', accent ? 2000 : 1300, accent ? 2000 : 1300, 0.03, accent ? 0.35 : 0.2, 0.001);
    },
    star(n) {
      const t = ac.currentTime;
      tone(t, 'triangle', 440 * 2 ** ((n * 2) / 12), 440 * 2 ** ((n * 2 + 5) / 12), 0.12, 0.3);
    },
    submit() {
      const t = ac.currentTime;
      [0, 4, 7, 12].forEach((s, i) => tone(t + i * 0.06, 'square', 523 * 2 ** (s / 12), 523 * 2 ** (s / 12), 0.09, 0.08));
    },
    ding() {
      const t = ac.currentTime;
      tone(t, 'sine', 988, 988, 0.5, 0.25);
      tone(t + 0.12, 'sine', 1319, 1319, 0.7, 0.25);
    },
    // Crowd cheer: a swell of noise plus claps, bigger for a better score.
    cheer(stars = 3) {
      const t = ac.currentTime;
      const size = Math.max(0.3, stars / 5);
      noise(t, 1.6, 'bandpass', 1400, 0.35 * size, 0.5);
      noise(t + 0.1, 1.3, 'bandpass', 2600, 0.2 * size, 0.7);
      const claps = Math.round(10 + 24 * size);
      for (let i = 0; i < claps; i++) noise(t + Math.random() * 1.4, 0.05, 'bandpass', 1000 + Math.random() * 1500, 0.3 * size, 1.5);
    },
    // Air horn: detuned saws with a little pitch scoop. BWAP BWAP BWAAAAP.
    airhorn() {
      const t0 = ac.currentTime;
      [[0, 0.16], [0.22, 0.16], [0.44, 0.8]].forEach(([d, len]) => {
        const t = t0 + d;
        const g = ac.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
        g.gain.setValueAtTime(0.18, t + len - 0.05);
        g.gain.exponentialRampToValueAtTime(0.0001, t + len);
        const f = ac.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = 2600;
        f.connect(g).connect(sfxGain);
        [0, 7, -9, 1205].forEach((cents) => {
          const o = ac.createOscillator();
          o.type = 'sawtooth';
          o.frequency.setValueAtTime(400, t);
          o.frequency.exponentialRampToValueAtTime(466, t + 0.05);
          o.detune.value = cents;
          o.connect(f);
          o.start(t);
          o.stop(t + len + 0.05);
        });
      });
    },
  };
  function playSfx(name, ...args) {
    if (!ac || ac.state !== 'running') return;
    sfx[name](...args);
  }

  // ---------- Music and sound effects on/off ----------
  function applySoundPrefs() {
    if (sfxGain) sfxGain.gain.value = soundPrefs.sfx ? 0.8 : 0;
    if (musicGain) musicGain.gain.value = soundPrefs.music ? 1 : 0;
    [['music-toggle', soundPrefs.music, 'Music'], ['sfx-toggle', soundPrefs.sfx, 'Sound effects']].forEach(([id, on, label]) => {
      const btn = $(id);
      btn.setAttribute('aria-pressed', String(on));
      btn.classList.toggle('off', !on);
      btn.title = `${label} ${on ? 'on' : 'off'} (click to turn ${on ? 'off' : 'on'})`;
    });
  }
  [['music-toggle', 'music'], ['sfx-toggle', 'sfx']].forEach(([id, key]) => {
    $(id).addEventListener('click', (e) => {
      soundPrefs[key] = !soundPrefs[key];
      try { localStorage.setItem(`rapmates-${key}`, soundPrefs[key] ? 'on' : 'off'); } catch { /* private mode */ }
      applySoundPrefs();
      if (e.detail) e.currentTarget.blur();
    });
  });
  applySoundPrefs();

  // ---------- Mic characters ----------

  // A gritty chrome mic: wire-mesh grille, a band in the player's colour, paint drips down the handle,
  // and for the mascot / winners a bandana wrap and a gold chain. Ids are unique per drawing.
  let micId = 0;
  function micSvg(color, { chain = false, bandana = false } = {}) {
    const id = `mic${++micId}`;
    return `
      <defs>
        <radialGradient id="${id}c" cx="38%" cy="30%" r="75%"><stop offset="0" stop-color="#ffffff"/><stop offset=".35" stop-color="#c9ced6"/><stop offset=".7" stop-color="#6b7079"/><stop offset="1" stop-color="#2c2f35"/></radialGradient>
        <linearGradient id="${id}h" x1="0" x2="1"><stop offset="0" stop-color="#1a1a1a"/><stop offset=".45" stop-color="#5a5a5a"/><stop offset=".6" stop-color="#2e2e2e"/><stop offset="1" stop-color="#111"/></linearGradient>
        <clipPath id="${id}g"><circle cx="50" cy="34" r="27"/></clipPath>
      </defs>
      <ellipse cx="50" cy="115" rx="18" ry="3.5" fill="rgba(0,0,0,.35)"/>
      <path d="M40 62h20l-3 48a7 7 0 0 1-14 0z" fill="url(#${id}h)"/>
      <g stroke="rgba(255,255,255,.12)" stroke-width="2"><path d="M42 74h16M42.5 82h15M43 90h14M43.5 98h13"/></g>
      <path d="M44 66c0 10-2 14 1 20s-1 9 1 12" stroke="${color}" stroke-width="4" fill="none" stroke-linecap="round" opacity=".9"/>
      <circle cx="46" cy="99" r="2.6" fill="${color}" opacity=".9"/>
      <path d="M55 66v13" stroke="${color}" stroke-width="3" stroke-linecap="round" opacity=".85"/><circle cx="55" cy="82" r="2.1" fill="${color}" opacity=".85"/>
      <rect x="33" y="55" width="34" height="11" rx="3" fill="${color}"/>
      <rect x="33" y="55" width="34" height="3.5" rx="1.75" fill="rgba(255,255,255,.35)"/>
      <circle cx="50" cy="34" r="27" fill="url(#${id}c)"/>
      <g clip-path="url(#${id}g)" stroke="rgba(20,22,26,.55)" stroke-width="1.6">
        ${[...Array(12).keys()].map((i) => `<path d="M${10 + i * 7} 0 L${i * 7 - 20} 70"/><path d="M${i * 7 - 20} 0 L${10 + i * 7} 70"/>`).join('')}
      </g>
      <circle cx="50" cy="34" r="27" fill="none" stroke="#1b1d21" stroke-width="2.5"/>
      <ellipse cx="40" cy="20" rx="9" ry="4.5" fill="rgba(255,255,255,.55)" transform="rotate(-30 40 20)"/>
      ${bandana ? `<path d="M23 36q27 9 54 0l-1 9q-26 8-52 0z" fill="${color}"/><path d="M23 36q27 9 54 0" stroke="rgba(0,0,0,.25)" stroke-width="1.5" fill="none"/>
        <g fill="#fff" opacity=".7"><circle cx="33" cy="42" r="1.4"/><circle cx="44" cy="44" r="1.4"/><circle cx="56" cy="44" r="1.4"/><circle cx="67" cy="42" r="1.4"/></g>
        <path d="M77 38l12-6-3 9 6 5-14-1z" fill="${color}"/><path d="M77 38l12-6-3 9" stroke="rgba(0,0,0,.25)" stroke-width="1" fill="none"/>` : ''}
      ${chain ? `<path d="M31 62q19 30 38 0" stroke="#F6C445" stroke-width="3.2" fill="none" stroke-dasharray="3.2 1.8" stroke-linecap="round"/>
        <path d="M31 62q19 30 38 0" stroke="#a87a10" stroke-width="1" fill="none" stroke-dasharray="3.2 1.8" transform="translate(0 1.2)"/>
        <rect x="44" y="76" width="12" height="13" rx="2.5" fill="#F6C445" stroke="#a87a10" stroke-width="1.2"/><path d="M47 83h6" stroke="#a87a10" stroke-width="1.6"/>` : ''}`;
  }
  $('mascot').innerHTML = micSvg('#E5484D', { chain: true, bandana: true });

  // ---------- Backing tracks ----------
  // Every track is fetched and decoded as soon as you're in a room or start solo practice, so a turn
  // never waits on the network. If a track can't be loaded the synth fallback (beats.js) plays.

  const trackBuffers = new Map(); // track id -> Promise<AudioBuffer> (with .buffer / .failed once settled)
  function loadTracks() {
    const a = getAudioCtx();
    if (!a) return;
    loadClap();
    Tracks.TRACKS.forEach((t) => {
      if (trackBuffers.has(t.id)) return;
      const pending = fetch(t.src)
        .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); })
        .then((data) => new Promise((ok, fail) => a.decodeAudioData(data, ok, fail)));
      pending.then((buffer) => { pending.buffer = buffer; }, (err) => {
        pending.failed = true;
        console.warn(`Couldn't load ${t.src}; using the synth fallback.`, err);
      });
      trackBuffers.set(t.id, pending);
    });
  }
  // The golf clap that marks the end of a round.
  let clapBuffer = null;
  let clapLoading = false;
  function loadClap() {
    const a = getAudioCtx();
    if (!a || clapLoading) return;
    clapLoading = true;
    fetch('sfx/golf-clap.mp3')
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); })
      .then((data) => new Promise((ok, fail) => a.decodeAudioData(data, ok, fail)))
      .then((b) => { clapBuffer = b; }, (err) => { clapLoading = false; console.warn("Couldn't load the golf clap.", err); });
  }
  function playClap() {
    if (!clapBuffer || !ac || ac.state !== 'running') return;
    const src = ac.createBufferSource();
    src.buffer = clapBuffer;
    src.connect(sfxGain);
    src.start();
  }
  const trackLabel = (t) => t.name;

  // ---------- Lobby UI ----------

  function showError(msg) {
    $('error-msg').textContent = msg || '';
  }

  const isHost = () => state.playerId && state.playerId === state.hostId;
  const me = () => [...state.lobby.players, ...state.lobby.crowd].find((m) => m.id === state.playerId);
  const PREVIEW = { id: 'preview', number: 1, name: 'You', color: Engine.PLAYER_COLORS[0] };

  function buildSlots() {
    $('slots').replaceChildren(...[1, 2, 3, 4].map((n) => {
      const slot = document.createElement('div');
      slot.className = 'slot';
      slot.innerHTML = `<span class="slot-num">P${n}</span><svg class="avatar" viewBox="0 0 100 120" aria-hidden="true"></svg>`
        + '<span class="slot-name"></span><span class="slot-tag"></span>';
      return slot;
    }));
  }

  function renderSlots() {
    const players = state.playerId ? state.lobby.players : [PREVIEW];
    [...$('slots').children].forEach((slot, i) => {
      const p = players.find((pl) => pl.number === i + 1);
      const isYou = p && (p.id === state.playerId || p === PREVIEW);
      const key = p ? `${p.id}|${p.name}` : '';
      if (slot.dataset.key === key) {
        slot.querySelector('.slot-tag').textContent = slotTag(p, isYou);
        return;
      }
      slot.dataset.key = key;
      slot.classList.toggle('filled', !!p);
      slot.classList.toggle('you', !!isYou);
      slot.style.setProperty('--pc', p ? p.color : '#ccc');
      slot.querySelector('.avatar').innerHTML = p ? micSvg(p.color) : '<circle cx="50" cy="40" r="26" fill="none" stroke="#3a3835" stroke-width="2" stroke-dasharray="5 6"/>';
      slot.querySelector('.slot-name').textContent = p ? p.name : 'Open mic';
      slot.querySelector('.slot-tag').textContent = slotTag(p, isYou);
    });
    const crowd = state.lobby.crowd;
    $('crowd-line').hidden = !state.playerId || !crowd.length;
    $('crowd-line').innerHTML = `<b>Crowd: ${crowd.length}</b> `
      + crowd.map((m) => `<span class="chip${m.id === state.playerId ? ' you' : ''}">${esc(m.name)}${m.id === state.playerId ? ' (you)' : ''}${!state.linkRoom && m.id === state.hostId ? ' · host' : ''}</span>`).join('');
  }
  function slotTag(p, isYou) {
    if (!p || p === PREVIEW) return '';
    return [isYou && 'YOU', !state.linkRoom && p.id === state.hostId && 'HOST'].filter(Boolean).join(' · ');
  }

  function applyLobby(payload) {
    state.hostId = payload.hostId;
    state.lobby = { players: payload.players || [], crowd: payload.crowd || [], started: !!payload.started, mode: payload.mode || Engine.DEFAULT_MODE };
    $('setup-view').style.display = 'none';
    $('room-view').style.display = 'block';
    $('room-code-txt').textContent = payload.roomCode;
    $('lobby-card').classList.toggle('link-room', state.linkRoom);
    renderSlots();
    const count = state.lobby.players.length;
    const host = [...state.lobby.players, ...state.lobby.crowd].find((m) => m.id === state.hostId);
    $('start-btn').textContent = `Start ${MODE_LABELS[state.lobby.mode]} with ${count} player${count === 1 ? '' : 's'}`;
    renderModePick();
    $('start-btn').style.display = isHost() && !state.lobby.started ? 'block' : 'none';
    $('rejoin-btn').style.display = state.lobby.started && state.away ? 'block' : 'none';
    let wait = '';
    if (state.lobby.started) wait = state.away ? 'A game is on right now.' : '';
    else if (!isHost()) wait = `Waiting for ${host ? host.name : 'the host'} to start...`;
    if (!state.lobby.started && me() && me().role === 'crowd') wait = `You're in the crowd: watch the rappers and vote! ${wait}`;
    $('wait-msg').textContent = wait;
    $('room-code-txt').classList.toggle('long', payload.roomCode.length > 6);
    $('share-link').value = shareLink(payload.roomCode);
    history.replaceState(null, '', `${basePath()}?room=${encodeURIComponent(payload.roomCode.toLowerCase())}`);
    if (state.game) renderChips();
    updateResultsButtons();
  }

  // The host picks the mode; everyone else sees it.
  function renderModePick() {
    const canPick = isHost() && !state.lobby.started;
    document.querySelectorAll('.mode-opt').forEach((b) => {
      const on = b.dataset.mode === state.lobby.mode;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
      b.disabled = !canPick;
    });
    $('mode-note').textContent = canPick ? '' : `Mode: ${MODE_LABELS[state.lobby.mode]} (the host picks)`;
  }
  document.querySelectorAll('.mode-opt').forEach((b) => b.addEventListener('click', () => {
    if (!isHost() || state.lobby.started || b.dataset.mode === state.lobby.mode) return;
    state.lobby.mode = b.dataset.mode;
    renderModePick();
    const count = state.lobby.players.length;
    $('start-btn').textContent = `Start ${MODE_LABELS[state.lobby.mode]} with ${count} player${count === 1 ? '' : 's'}`;
    net.emit('input', { type: 'mode', mode: b.dataset.mode });
  }));

  function showLobby() {
    stopStage();
    hideWrite();
    $('game-view').style.display = 'none';
    $('lobby-card').style.display = 'block';
    document.body.classList.remove('in-game');
  }

  function enterGame() {
    $('lobby-card').style.display = 'none';
    $('game-view').style.display = 'flex';
    document.body.classList.add('in-game');
  }

  // Directory the game is served from, e.g. "/rapmates/" on GitHub Pages or "/" locally.
  function basePath() {
    return location.pathname.replace(/[^/]*$/, '');
  }

  function shareLink(roomCode) {
    return `${location.origin}${basePath()}${roomCode.toLowerCase()}`;
  }

  function resetToSetup() {
    history.replaceState(null, '', basePath());
    state.linkRoom = false;
    $('lobby-card').classList.remove('link-room');
    state.playerId = null;
    state.hostId = null;
    state.lobby = { players: [], crowd: [], started: false, mode: Engine.DEFAULT_MODE };
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
    loadTracks();
    applyLobby(res);
  }

  $('create-btn').addEventListener('click', () => {
    setConnecting(true);
    net.emit('createRoom', handleJoinResponse);
  });
  $('join-btn').addEventListener('click', () => {
    const code = $('room-input').value.trim().toUpperCase();
    if (!/^[A-Z]{4}$/.test(code)) return showError('Enter a 4-letter room code.');
    setConnecting(true);
    net.emit('joinRoom', code, handleJoinResponse);
  });
  $('room-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('join-btn').click();
  });
  $('solo-btn').addEventListener('click', () => startSolo());

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

  // Home: solo goes back to the home screen; in a room, just you go back to the lobby (still in the
  // room, the show goes on without you until you press "Back to the show").
  $('game-home').addEventListener('click', () => {
    if (state.solo) return exitSolo();
    state.away = !!state.lobby.started;
    showLobby();
    $('rejoin-btn').style.display = state.away ? 'block' : 'none';
  });
  // Link rooms: leave and go back to the home screen to create or join a different room.
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

  // Apps that embed the game pass their own session id as ?group=<id> (any length or characters), so each
  // group gets its own link room instead of everyone sharing /mate. The id is hashed into a 4-letter code
  // like any other room (same letters, no I or O), so it can also be typed in to join.
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
  // Links like /rapmates/mate (or ?room=mate) open that room: join it if someone is hosting, otherwise host it.
  function enterRoomFromUrl() {
    const params = new URLSearchParams(location.search);
    const requested = params.get('room') || groupRoom(params.get('group'));
    if (!requested) return;
    if (!window.RapmatesNet.normaliseRoomName(requested)) {
      history.replaceState(null, '', basePath());
      return showError('Room names are 2-16 letters, numbers or dashes.');
    }
    state.linkRoom = true;
    $('lobby-card').classList.add('link-room');
    setConnecting(true);
    net.emit('enterRoom', requested, handleJoinResponse);
  }

  // ---------- Game: phases from the host ----------

  net.on('gameStarted', (payload) => {
    state.away = false;
    state.over = null;
    state.game = { round: payload.round, order: payload.order, results: payload.results || [], mode: payload.mode || 'freestyle', totals: payload.totals || [] };
    loadTracks();
    applyLobby(payload);
    $('reconnect-hint').style.display = 'none';
    enterGame();
    renderChips();
    applyPhase(payload);
  });

  net.on('phase', (p) => {
    if (!state.game) return;
    if (p.phase === 'score' && p.result && !state.game.results.some((r) => r.id === p.result.id)) state.game.results.push(p.result);
    applyPhase(p);
  });

  net.on('votes', (v) => {
    if (!state.phase || state.phase.phase !== 'vote' || v.turnIndex !== state.phase.turnIndex) return;
    if (v.round !== undefined && v.round !== state.phase.wbRound) return;
    state.phase.votes = v;
    renderVoteCount();
  });

  net.on('writers', (d) => {
    if (!state.phase || state.phase.phase !== 'write' || d.round !== state.phase.wbRound) return;
    state.phase.writers = d.writers;
    renderWriters();
  });

  net.on('gameOver', (over) => {
    state.over = over;
    state.phase = { phase: 'results' };
    state.lobby.started = false;
    if (state.away || state.solo) return;
    showResults(over);
  });

  function hideOverlays() {
    document.querySelectorAll('.overlay').forEach((o) => o.classList.remove('show'));
  }

  const sameTurn = (a, b) => a && b && a.rapperId === b.rapperId && a.startAt === b.startAt;

  function applyPhase(p, force = false) {
    state.phase = p;
    if (state.game && p.totals) state.game.totals = p.totals;
    if (state.away || state.solo) return;
    if (p.phase === 'results') {
      if (state.over) showResults(state.over);
      return;
    }
    if (p.phase === 'write') {
      stopStage();
      showWrite(p);
      renderChips();
      return;
    }
    hideWrite();
    if (p.turn && (force || !sameTurn(stage.turn, p.turn))) {
      setupTurn(p.turn, { solo: false });
    }
    renderChips();
    hideOverlays();
    if (p.phase === 'vote' && p.mode === 'writebars') showWbVote(p);
    else if (p.phase === 'vote') showVote(p);
    else if (p.phase === 'score') showScore(p);
    else if (p.phase === 'standings') showStandings(p);
  }

  function renderChips() {
    const chips = $('chips');
    if (state.solo || !state.game) {
      chips.replaceChildren();
      return;
    }
    const rapperId = state.phase && state.phase.turn && state.phase.phase !== 'results' ? state.phase.turn.rapperId : null;
    const players = state.lobby.players;
    chips.replaceChildren(...players.map((p) => {
      const chip = document.createElement('div');
      chip.className = `chip-p${p.id === rapperId ? ' on-mic' : ''}`;
      chip.style.setProperty('--pc', p.color);
      let score = '';
      if (state.game.mode === 'writebars') {
        const t = (state.game.totals || []).find((x) => x.id === p.id);
        if (t) score = `${t.total}★`;
      } else {
        const r = state.game.results.find((x) => x.id === p.id);
        score = r ? (r.average === null ? '–' : `${r.average.toFixed(1)}★`) : '';
      }
      chip.innerHTML = `<span class="dot">P${p.number}</span><span class="name">${esc(p.name)}${p.id === state.playerId ? ' (you)' : ''}</span>${score ? `<span class="score">${score}</span>` : ''}`;
      return chip;
    }));
    const crowd = state.lobby.crowd.length;
    if (crowd) {
      const chip = document.createElement('div');
      chip.className = 'chip-p';
      chip.style.setProperty('--pc', '#8a8a8a');
      chip.innerHTML = `<span class="dot">👥</span><span>Crowd: ${crowd}</span>`;
      chips.append(chip);
    }
  }

  // ---------- Voting ----------

  const STAR_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.2l2.9 6.2 6.8.8-5 4.7 1.3 6.7L12 17.3l-6 3.3 1.3-6.7-5-4.7 6.8-.8z" fill="currentColor" stroke="rgba(0,0,0,.12)" stroke-width="1" stroke-linejoin="round"/></svg>';
  $('stars').replaceChildren(...[1, 2, 3, 4, 5].map((n) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'star';
    b.dataset.n = n;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-label', `${n} star${n > 1 ? 's' : ''}`);
    b.innerHTML = STAR_SVG;
    b.addEventListener('click', () => pickStars(n));
    return b;
  }));
  function pickStars(n) {
    if (state.voted) return;
    state.myVote = n;
    document.querySelectorAll('.star').forEach((s) => {
      const on = Number(s.dataset.n) <= n;
      s.classList.toggle('on', on);
      s.classList.remove('pop');
      if (on) { void s.offsetWidth; s.classList.add('pop'); }
      s.setAttribute('aria-checked', String(Number(s.dataset.n) === n));
    });
    $('vote-btn').disabled = false;
    playSfx('star', n);
  }
  $('vote-btn').addEventListener('click', () => {
    if (!state.myVote || state.voted || !state.phase || state.phase.phase !== 'vote') return;
    state.voted = true;
    net.emit('input', { type: 'vote', stars: state.myVote, turn: state.phase.turnIndex });
    playSfx('submit');
    renderVoteState();
  });
  window.addEventListener('keydown', (e) => {
    if (!$('vote-overlay').classList.contains('show') || e.target.tagName === 'INPUT') return;
    if (state.phase && state.phase.mode === 'writebars') return;
    if (/^[1-5]$/.test(e.key)) pickStars(Number(e.key));
    else if (e.key === 'Enter' && !$('vote-btn').disabled) $('vote-btn').click();
  });

  function showVote(p) {
    const isRapper = p.turn.rapperId === state.playerId;
    const isNewVote = state.voteTurn !== `${state.game.round}:${p.turnIndex}`;
    if (isNewVote) {
      state.voteTurn = `${state.game.round}:${p.turnIndex}`;
      state.myVote = 0;
      state.voted = false;
      document.querySelectorAll('.star').forEach((s) => s.classList.remove('on', 'pop'));
      $('vote-btn').disabled = true;
      playSfx('ding');
    }
    if (p.votes && p.votes.voted.includes(state.playerId)) state.voted = true;
    $('vote-overlay').classList.remove('wb');
    $('wb-vote').hidden = true;
    $('vote-title').textContent = isRapper ? 'The crowd is rating your bars...' : `How were ${p.turn.name}'s bars?`;
    $('vote-title').style.color = p.turn.color;
    $('vote-stars-wrap').style.display = isRapper ? 'none' : 'block';
    renderVoteState();
    renderVoteCount();
    $('vote-overlay').classList.add('show');
  }
  function renderVoteState() {
    const p = state.phase;
    if (!p || !p.turn) return;
    const isRapper = p.turn.rapperId === state.playerId;
    let msg = 'Tap the stars (or press 1-5), then submit.';
    if (isRapper) msg = 'Nice bars! Sit tight.';
    else if (state.voted) msg = 'Vote in! Waiting for everyone else...';
    $('vote-msg').textContent = msg;
    $('vote-btn').textContent = state.voted ? 'Submitted ✓' : 'Submit';
    if (state.voted) $('vote-btn').disabled = true;
  }
  // Clocks that run whatever the stage is doing: the write timer and the vote timer bar.
  setInterval(() => {
    updateWriteClock();
    const ph = state.phase;
    if (ph && ph.phase === 'vote' && ph.voteEndsAt && $('vote-overlay').classList.contains('show')) {
      const total = ph.voteMs || Engine.VOTE_SECONDS * 1000;
      const left = Math.max(0, Math.min(1, (ph.voteEndsAt - net.hostNow()) / total));
      $('vote-timer').style.transform = `scaleX(${left})`;
    }
  }, 50);

  function renderVoteCount() {
    const v = state.phase && state.phase.votes;
    if (!v) return;
    $('vote-count').textContent = `${v.count} of ${v.needed} voted`;
  }

  function starsText(avg) {
    const full = Math.round(avg || 0);
    return `${'★'.repeat(full)}<span class="dim">${'★'.repeat(5 - full)}</span>`;
  }

  function showScore(p) {
    const r = p.result;
    if (!r) return;
    $('score-name').textContent = r.id === state.playerId ? 'You' : r.name;
    $('score-name').style.color = r.color;
    $('score-num').textContent = r.average === null ? '–' : r.average.toFixed(1);
    $('score-stars').innerHTML = starsText(r.average);
    $('score-votes').textContent = r.votes ? `from ${r.votes} vote${r.votes === 1 ? '' : 's'}` : 'No votes this time';
    $('score-overlay').classList.add('show');
    if (state.scoreShown !== `${state.game.round}:${p.turnIndex}`) {
      state.scoreShown = `${state.game.round}:${p.turnIndex}`;
      playSfx('cheer', r.average || 1);
    }
  }

  // ---------- Write Bars: writing ----------
  // Everyone writes at once against the host's clock. Drafts go to the host as you type, so whatever's
  // written when the clock runs out is what gets performed.

  const write = { key: null, lines: ['', '', '', ''], voice: 'tts', done: false, draftTimer: null, finalSent: false, lastTick: null };

  // Escaped text with the rhyme words (anywhere in the line) wrapped in <mark>.
  function markRhymes(text, words) {
    if (!text) return '<span class="wb-empty">…</span>';
    const alts = words.slice().sort((a, b) => b.length - a.length)
      .map((w) => esc(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+'));
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${alts.join('|')})(?=$|[^\\p{L}\\p{N}])`, 'giu');
    return esc(text).replace(re, (m, pre, w) => `${pre}<mark>${w}</mark>`);
  }
  // Lines 1-2 rhyme on pair A, lines 3-4 on pair B.
  const targetWord = (pairs, i) => (pairs[Math.floor(i / 2)] || [])[i % 2] || '';

  function writersOf(p) {
    return p.writers || [];
  }

  function showWrite(p) {
    $('stage').style.display = 'none';
    $('write-view').hidden = false;
    const mine = writersOf(p).find((w) => w.id === state.playerId);
    const key = `${state.game.round}:${p.wbRound}`;
    if (write.key !== key) {
      write.key = key;
      write.lines = ['', '', '', ''];
      write.done = !!(mine && mine.done);
      write.finalSent = false;
      write.lastTick = null;
      clearTimeout(write.draftTimer);
      if (mine) buildWriteForm(mine.pairs);
      playSfx('ding');
    }
    $('write-round').innerHTML = `Round <b>${p.wbRound}</b> / ${p.rounds} · ${mine ? 'write your bars' : 'writing time'}`;
    $('write-form').hidden = !mine;
    $('write-watch').hidden = !!mine;
    renderWriteState();
    renderWriters();
    updateWriteClock();
  }

  function hideWrite() {
    $('write-view').hidden = true;
    $('stage').style.display = '';
    $('write-clock').classList.remove('panic', 'fast');
  }

  function buildWriteForm(pairs) {
    $('write-pairs').innerHTML = pairs.map((pair, i) => `<div class="write-pair"><small>Lines ${i * 2 + 1}–${i * 2 + 2}</small>`
      + `<span>${esc(pair[0])}<i>/</i>${esc(pair[1])}</span></div>`).join('');
    $('write-lines').replaceChildren(...[0, 1, 2, 3].map((i) => {
      const row = document.createElement('div');
      row.className = 'write-line';
      const word = targetWord(pairs, i);
      row.innerHTML = `<label for="write-${i}">Bar ${i + 1}<b>${esc(word)}</b></label>`
        + `<input type="text" id="write-${i}" maxlength="${Engine.LINE_MAX}" autocomplete="off" autocapitalize="sentences" enterkeyhint="${i < 3 ? 'next' : 'done'}" placeholder="…ends on &quot;${esc(word)}&quot;">`;
      const input = row.querySelector('input');
      input.addEventListener('input', () => {
        write.lines[i] = input.value;
        queueDraft();
      });
      input.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const next = $(`write-${i + 1}`);
        if (next) next.focus();
        else input.blur();
      });
      return row;
    }));
  }

  function renderWriteState() {
    document.querySelectorAll('.voice-opt').forEach((b) => {
      const on = b.dataset.voice === write.voice;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
      b.disabled = write.done;
    });
    $('write-lines').querySelectorAll('input').forEach((input) => { input.disabled = write.done; });
    $('write-done').disabled = write.done;
    $('write-done').textContent = write.done ? 'Locked in ✓' : 'Done';
  }

  function renderWriters() {
    const p = state.phase;
    if (!p || p.phase !== 'write') return;
    const writers = writersOf(p);
    $('writers').innerHTML = writers.map((w) => `<span class="writer${w.done ? ' done' : ''}" style="--pc:${w.color}">${esc(w.id === state.playerId ? 'You' : w.name)}</span>`).join('');
    const left = writers.filter((w) => !w.done).length;
    $('write-status').textContent = write.done ? (left ? `Locked in. Waiting for ${left} more...` : 'Locked in!') : '';
  }

  function sendDraft(type = 'draft') {
    clearTimeout(write.draftTimer);
    write.draftTimer = null;
    net.emit('input', { type, lines: write.lines.slice(), voice: write.voice });
  }
  function queueDraft() {
    if (write.done) return;
    clearTimeout(write.draftTimer);
    write.draftTimer = setTimeout(() => sendDraft(), 300);
  }

  document.querySelectorAll('.voice-opt').forEach((b) => b.addEventListener('click', () => {
    if (write.done) return;
    write.voice = b.dataset.voice;
    renderWriteState();
    queueDraft();
  }));
  $('write-done').addEventListener('click', () => {
    const p = state.phase;
    if (write.done || !p || p.phase !== 'write') return;
    write.done = true;
    sendDraft('done');
    playSfx('submit');
    renderWriteState();
    renderWriters();
  });

  // The big clock: red and pulsing from 10 seconds, with a tick every second (twice a second, louder,
  // for the last 3). At 0 whatever's written goes to the host.
  function updateWriteClock() {
    const p = state.phase;
    if (!p || p.phase !== 'write' || $('write-view').hidden) return;
    const left = p.writeEndsAt - net.hostNow();
    const secs = Math.max(0, Math.ceil(left / 1000));
    $('write-clock').textContent = secs;
    const panic = left > 0 && left <= 10000;
    $('write-clock').classList.toggle('panic', panic);
    $('write-clock').classList.toggle('fast', panic && left <= 3000);
    if (panic) {
      const urgent = left <= 3000;
      const mark = urgent ? `h${Math.ceil(left / 500)}` : `s${secs}`;
      if (mark !== write.lastTick) {
        write.lastTick = mark;
        if (ac && ac.state === 'running') sfx.tick(ac.currentTime, urgent);
      }
    }
    if (left <= 0 && !write.finalSent) {
      write.finalSent = true;
      if (!write.done && writersOf(p).some((w) => w.id === state.playerId)) {
        sendDraft();
        write.done = true;
        renderWriteState();
        $('write-status').textContent = "Time's up! Your bars are in.";
      }
    }
  }

  // ---------- Write Bars: voting and the scoreboard ----------

  function showWbVote(p) {
    const key = `${state.game.round}:wb${p.wbRound}`;
    if (state.voteTurn !== key) {
      state.voteTurn = key;
      state.wbStars = {};
      state.voted = false;
      playSfx('ding');
    }
    if (p.votes && p.votes.voted.includes(state.playerId)) state.voted = true;
    const rateable = p.performances.filter((x) => x.id !== state.playerId);
    $('vote-overlay').classList.add('wb');
    $('vote-stars-wrap').style.display = 'none';
    $('wb-vote').hidden = false;
    $('vote-title').textContent = `Round ${p.wbRound}: who spat it best?`;
    $('vote-title').style.color = '';
    $('wb-vote-list').replaceChildren(...p.performances.map((x) => {
      const mine = x.id === state.playerId;
      const words = x.pairs.flat();
      const card = document.createElement('div');
      card.className = 'wb-entry';
      card.style.setProperty('--pc', x.color);
      card.innerHTML = `<div class="wb-entry-head"><span class="wb-entry-name">${esc(mine ? `${x.name} (You)` : x.name)}</span>`
        + `<span class="wb-entry-tag">${x.voice === 'self' ? 'Rapped live' : 'Robot voice'}</span></div>`
        + `<ol>${x.lines.map((l) => `<li>${markRhymes(l, words)}</li>`).join('')}</ol>`;
      if (!mine) {
        const stars = document.createElement('div');
        stars.className = 'stars';
        stars.setAttribute('role', 'radiogroup');
        stars.setAttribute('aria-label', `Stars for ${x.name}`);
        stars.replaceChildren(...[1, 2, 3, 4, 5].map((n) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'star';
          b.dataset.n = n;
          b.setAttribute('role', 'radio');
          b.setAttribute('aria-label', `${n} star${n > 1 ? 's' : ''}`);
          b.innerHTML = STAR_SVG;
          b.addEventListener('click', () => {
            if (state.voted) return;
            state.wbStars[x.id] = n;
            paintStars(stars, n, true);
            playSfx('star', n);
            renderWbVoteState();
          });
          return b;
        }));
        paintStars(stars, state.wbStars[x.id] || 0, false);
        card.append(stars);
      }
      return card;
    }));
    state.wbRateable = rateable.map((x) => x.id);
    renderWbVoteState();
    renderVoteCount();
    $('vote-overlay').classList.add('show');
  }
  function paintStars(group, n, pop) {
    group.querySelectorAll('.star').forEach((s) => {
      const on = Number(s.dataset.n) <= n;
      s.classList.toggle('on', on);
      s.classList.remove('pop');
      if (on && pop) { void s.offsetWidth; s.classList.add('pop'); }
      s.setAttribute('aria-checked', String(Number(s.dataset.n) === n));
    });
  }
  function renderWbVoteState() {
    const ids = state.wbRateable || [];
    const rated = ids.filter((id) => state.wbStars[id]).length;
    let msg = `Rate every performance (${rated} of ${ids.length}), then submit.`;
    if (!ids.length) msg = 'Nobody else to rate. Sit tight!';
    else if (state.voted) msg = 'Votes in! Waiting for everyone else...';
    $('vote-msg').textContent = msg;
    $('wb-vote-btn').style.display = ids.length ? 'block' : 'none';
    $('wb-vote-btn').disabled = state.voted || rated < ids.length;
    $('wb-vote-btn').textContent = state.voted ? 'Submitted ✓' : 'Submit';
  }
  $('wb-vote-btn').addEventListener('click', () => {
    const p = state.phase;
    if (state.voted || !p || p.phase !== 'vote' || p.mode !== 'writebars') return;
    state.voted = true;
    net.emit('input', { type: 'votes', stars: { ...state.wbStars }, round: p.wbRound });
    playSfx('submit');
    renderWbVoteState();
  });

  function showStandings(p) {
    const last = p.wbRound >= p.rounds;
    $('standings-kicker').textContent = `Round ${p.wbRound} of ${p.rounds}`;
    $('standings-title').textContent = last ? 'Final scores' : 'Scoreboard';
    $('standings-table').innerHTML = p.roundResults.map((r, i) => `<div class="standing" style="--pc:${r.color};animation-delay:${0.08 * i}s">`
      + `<span class="pl">${i + 1}</span><span class="nm">${esc(r.id === state.playerId ? `${r.name} (You)` : r.name)}</span>`
      + `<span class="gain">+${r.stars} ★</span><span class="tot">${r.total} ★</span></div>`).join('')
      || '<p class="hint">Nobody performed this round.</p>';
    $('standings-next').textContent = last ? 'And the winner is...' : `Round ${p.wbRound + 1} is next: fresh rhymes, the clock starts again.`;
    $('standings-overlay').classList.add('show');
    const key = `${state.game.round}:st${p.wbRound}`;
    if (state.standingsShown !== key) {
      state.standingsShown = key;
      const best = p.roundResults.length ? Math.max(...p.roundResults.map((r) => (r.votes ? r.stars / r.votes : 0))) : 0;
      playSfx('cheer', best || 2);
    }
  }

  // ---------- Results ----------

  function updateResultsButtons() {
    $('again-btn').style.display = isHost() ? 'block' : 'none';
    const host = [...state.lobby.players, ...state.lobby.crowd].find((m) => m.id === state.hostId);
    $('results-wait').textContent = isHost() ? '' : `${host ? host.name : 'The host'} can start another round.`;
  }

  function showResults({ standings, winnerIds, mode }) {
    const wb = mode === 'writebars';
    const scoreOf = (r) => (wb ? r.total : r.average);
    stopStage();
    hideOverlays();
    const winners = standings.filter((r) => winnerIds.includes(r.id));
    const nameOf = (r) => (r.id === state.playerId ? 'You' : r.name);
    let title = 'No votes this time!';
    if (winners.length === 1) title = winners[0].id === state.playerId ? 'You take the mic!' : `${winners[0].name} takes the mic!`;
    else if (winners.length > 1) title = `It's a tie! ${winners.map(nameOf).join(' & ')} share the mic!`;
    $('results-title').textContent = title;
    // Places: ties share a place.
    const places = standings.map((r, i) => (i && scoreOf(r) === scoreOf(standings[i - 1]) ? null : i + 1));
    for (let i = 1; i < places.length; i++) if (places[i] === null) places[i] = places[i - 1];
    const ranked = standings.map((r, i) => ({ ...r, place: places[i] }));
    const display = ranked.length >= 2 ? [ranked[1], ranked[0], ...ranked.slice(2)] : ranked;
    const HEIGHTS = { 1: 150, 2: 112, 3: 84, 4: 62 };
    $('podium').replaceChildren(...display.map((r, i) => {
      const step = document.createElement('div');
      step.className = 'step';
      step.style.setProperty('--pc', r.color);
      step.style.animationDelay = `${0.15 * (display.length - i)}s`;
      step.innerHTML = `<svg class="avatar" viewBox="0 0 100 120" aria-hidden="true">${micSvg(r.color, { chain: r.place === 1 })}</svg>`
        + `<span class="who">${esc(nameOf(r))}</span>`
        + `<div class="block" style="height:${HEIGHTS[r.place] || 60}px"><span class="place">${r.place}</span>`
        + `<span class="avg">${wb ? `${r.total} ★` : r.average === null ? 'no votes' : `${r.average.toFixed(1)} ★`}</span></div>`;
      return step;
    }));
    updateResultsButtons();
    $('results-overlay').classList.add('show');
    if (winners.length) confetti();
    playSfx('airhorn');
  }

  function confetti() {
    const box = $('confetti');
    const colours = ['#F6C445', '#F6C445', '#E5484D', '#F2EDE4', '#b9bec7', '#d9a92e'];
    for (let i = 0; i < 140; i++) {
      const c = document.createElement('div');
      c.className = 'confetto';
      c.style.left = `${Math.random() * 100}%`;
      c.style.background = colours[i % colours.length];
      c.style.setProperty('--dx', `${(Math.random() - 0.5) * 300}px`);
      c.style.setProperty('--rot', `${Math.random() * 1440 - 720}deg`);
      c.style.animationDuration = `${2.4 + Math.random() * 2.2}s`;
      c.style.animationDelay = `${Math.random() * 0.8}s`;
      if (Math.random() < 0.4) { c.style.width = '8px'; c.style.height = '8px'; c.style.borderRadius = '50%'; }
      box.append(c);
    }
    setTimeout(() => box.replaceChildren(), 5600);
  }

  // ---------- Solo practice ----------

  async function startSolo() {
    getAudioCtx();
    loadTracks();
    const names = Engine.RAP_NAMES;
    state.solo = state.solo || { name: names[Math.floor(Math.random() * names.length)], lastTrackId: null };
    const track = Tracks.byId(soloTrackChoice) || Tracks.pickTrack(state.solo.lastTrackId);
    state.solo.lastTrackId = track.id;
    // The first time, give the track a moment to finish decoding so it starts from the top.
    const pending = trackBuffers.get(track.id);
    if (pending && !pending.buffer) await Promise.race([pending.catch(() => {}), new Promise((r) => setTimeout(r, 4000))]);
    if (!state.solo) return;
    const startAt = localNow() + SOLO_LEAD_MS;
    const turn = {
      rapperId: 'solo', name: state.solo.name, color: '#F6C445', startAt, endAt: startAt + Engine.turnLengthMs(track),
      pairs: Words.drawPairs(), trackId: track.id, bpm: track.bpm,
    };
    showError('');
    enterGame();
    renderChips();
    hideOverlays();
    setupTurn(turn, { solo: true });
  }
  function exitSolo() {
    state.solo = null;
    showLobby();
    $('setup-view').style.display = 'block';
  }
  // Testing aid: pick the solo beat (or leave it random). Both dropdowns share the choice.
  let soloTrackChoice = '';
  const soloSelects = [$('solo-track'), $('solo-track-again')];
  soloSelects.forEach((sel) => {
    sel.innerHTML = '<option value="">Beat: random</option>'
      + Tracks.TRACKS.map((t) => `<option value="${t.id}">Beat: ${esc(trackLabel(t))}</option>`).join('');
    sel.addEventListener('change', () => {
      soloTrackChoice = sel.value;
      soloSelects.forEach((other) => { other.value = soloTrackChoice; });
    });
  });
  $('solo-again-btn').addEventListener('click', () => startSolo());
  $('solo-home-btn').addEventListener('click', () => exitSolo());

  // ---------- The stage: bars, count-in and the bouncing ball ----------
  // Everything is driven by the turn's start time. The beat is scheduled on the audio clock at that
  // moment; the ball and the bars read the audio clock every frame, so they stay tight to the beat.

  const stage = {
    turn: null,
    bars: [],
    rows: [],
    ghost: null,
    track: null,
    bpm: 90,
    beatSec: 60 / 90,
    introBeats: 16, // the track's intro bars, in beats (bars 3-4 of them are the count-in)
    solo: false,
    audio: null, // { gain, src, synth } playing this turn's track
    audioStart: null, // audio (speaker) time of the track's intro bar 1, beat 1
    anchoredOffset: 0,
    currentBar: -1,
    lastBeat: null,
    countShown: null,
    geometry: null,
    trail: [],
    raf: null,
    soloDone: false,
    wb: false, // a Write Bars performance: lines instead of bar rows
    rapBars: BARS,
    rapBeats: TOTAL_BEATS,
    wbLine: -1,
    wbBeat: null,
    lineEls: [],
    lineLog: [], // ?debug: when each line appeared vs its bar
    ttsTimers: [],
    ttsQueued: [],
  };
  const canvas = $('ball-canvas');
  const cctx = canvas.getContext('2d');

  function offsetMs() {
    return stage.solo ? 0 : net.clockOffset;
  }
  // The turn's start in this browser's clock.
  const localStartMs = () => stage.turn.startAt - offsetMs();

  // Each couplet (2 bars sharing a rhyme pair) gets its own colour, starting with blue. Green is kept
  // for the ball and finished beats. [empty cell, its edge, word cell, its edge, word ink]
  const COUPLET_COLOURS = [
    ['#132840', '#0a1626', '#4E9BE0', '#2a5f93', '#06172a'], // blue
    ['#3a2810', '#221706', '#F2A93B', '#a46b14', '#2a1a02'], // amber
    ['#3a1434', '#220a1f', '#D45CB9', '#8d2f78', '#24061f'], // magenta
    ['#0e3134', '#061d1f', '#3EBFB4', '#21807a', '#04211f'], // teal
    ['#3e1416', '#250a0b', '#E5484D', '#9b2a2e', '#ffffff'], // red
    ['#3a3010', '#231d07', '#F6C445', '#ad861a', '#2b2104'], // gold
    ['#241a44', '#150f2a', '#9C7DEB', '#6447b0', '#140b2b'], // violet
    ['#0d2e3d', '#061b25', '#4FC8EA', '#2787a6', '#03202b'], // cyan
  ];

  function makeRow(bar, ghost = false) {
    const row = document.createElement('div');
    row.className = `bar-row${ghost ? ' ghost' : ''}`;
    const [cell, cellEdge, word, wordEdge, ink] = COUPLET_COLOURS[bar.couplet % COUPLET_COLOURS.length];
    Object.entries({ '--cell': cell, '--cell-edge': cellEdge, '--word': word, '--word-edge': wordEdge, '--word-ink': ink })
      .forEach(([k, v]) => row.style.setProperty(k, v));
    row.innerHTML = `<span class="bar-num">${bar.index + 1}</span><div class="cell"></div><div class="cell"></div><div class="cell"></div>`
      + `<div class="cell word"><span style="--len:${bar.word.length}">${esc(bar.word)}</span></div>`;
    return row;
  }

  function setupTurn(turn, { solo }) {
    stopStage();
    const track = Tracks.byId(turn.trackId) || Tracks.TRACKS[0];
    stage.turn = turn;
    stage.solo = solo;
    stage.track = track;
    stage.bpm = track.bpm;
    stage.beatSec = 60 / track.bpm;
    stage.introBeats = track.introBars * BPB;
    stage.wb = turn.mode === 'writebars';
    stage.rapBars = turn.rapBars || BARS;
    stage.rapBeats = stage.rapBars * BPB;
    $('stage').classList.toggle('wb', stage.wb);
    if (stage.wb) return setupPerformance(turn, track);
    stage.bars = Words.buildBars(turn.pairs);
    stage.currentBar = -1;
    stage.lastBeat = null;
    stage.countShown = null;
    stage.trail = [];
    stage.soloDone = false;
    stage.ended = false;
    const barsEl = $('bars');
    stage.rows = stage.bars.map((b) => makeRow(b));
    stage.ghost = makeRow(stage.bars[0], true);
    barsEl.replaceChildren(stage.ghost, ...stage.rows);
    stage.rows.forEach((row) => { row.style.transition = 'none'; });
    updateRows(0);
    void barsEl.offsetWidth;
    stage.rows.forEach((row) => { row.style.transition = ''; });
    $('mic-drop').style.display = 'none';
    $('count').className = 'count';
    const isMe = solo || turn.rapperId === state.playerId;
    const micName = $('mic-name');
    micName.style.setProperty('--pc', turn.color);
    micName.innerHTML = `<b>${esc(isMe ? `${turn.name} (You)` : turn.name)}</b> is on the mic`;
    $('ready-kicker').textContent = 'Get ready';
    $('ready-avatar').innerHTML = micSvg(turn.color, { chain: true });
    $('ready-name').textContent = turn.name;
    $('ready-name').style.setProperty('--pc', turn.color);
    $('ready-line').textContent = isMe ? "you're on the mic" : 'is on the mic';
    $('ready-beat').textContent = trackLabel(track);
    $('game-hint').textContent = isMe
      ? 'Rap along to the beat. Land the word in the 4th box right when the ball hits it.'
      : `Watch ${turn.name} land each rhyme on the 4th beat. You'll rate their bars after 16 bars.`;
    stage.geometry = null;
    anchorAudio();
    stage.raf = requestAnimationFrame(frame);
  }

  // Write Bars: the performer's 4 lines on the plain brick, each appearing on its bar.
  function setupPerformance(turn, track) {
    stage.currentBar = -1;
    stage.countShown = null;
    stage.ended = false;
    stage.wbLine = -1;
    stage.wbBeat = null;
    stage.lineLog = [];
    stage.ttsQueued = [];
    const words = turn.pairs.flat();
    stage.lineEls = turn.lines.map((text, i) => {
      const el = document.createElement('div');
      el.className = 'wb-line';
      el.dataset.k = i + 1;
      el.innerHTML = markRhymes(text, words);
      return el;
    });
    $('wb-lines').replaceChildren(...stage.lineEls);
    $('wb-beats').querySelectorAll('i').forEach((d) => d.classList.remove('lit', 'down'));
    $('mic-drop').style.display = 'none';
    $('count').className = 'count';
    const isMe = turn.rapperId === state.playerId;
    const micName = $('mic-name');
    micName.style.setProperty('--pc', turn.color);
    micName.innerHTML = `<b>${esc(isMe ? `${turn.name} (You)` : turn.name)}</b> is on the mic`;
    $('ready-kicker').textContent = `Round ${turn.wbRound} · ${turn.perf + 1} of ${turn.perfs}`;
    $('ready-avatar').innerHTML = micSvg(turn.color, { chain: true });
    $('ready-name').textContent = turn.name;
    $('ready-name').style.setProperty('--pc', turn.color);
    $('ready-line').textContent = isMe ? "you're on the mic" : 'is on the mic';
    $('ready-beat').textContent = trackLabel(track);
    const tts = turn.voice !== 'self';
    const voice = tts ? pickVoice(turn.voiceGender) : null;
    if (!tts) $('game-hint').textContent = isMe ? 'Rap each line as it appears: 2 bars a line.' : `${turn.name} spits it live`;
    else if (!window.speechSynthesis) $('game-hint').textContent = 'Robot voice not available on this device: read along!';
    else $('game-hint').textContent = `Robot voice${voice ? `: ${voice.name}` : ''}. Each line drops on the beat.`;
    stage.geometry = null;
    anchorAudio();
    scheduleSpeech(); // also when the beat can't play yet (anchorAudio bails out)
    stage.raf = requestAnimationFrame(frame);
  }

  // ---------- Robot voice (speechSynthesis) ----------
  // The browser's own text-to-speech, on every screen in the room. Voices alternate male / female down
  // the order (the host decides which); each browser picks the closest English voice it has.
  const VOICE_PREFS = {
    male: ['Google UK English Male', 'Daniel', 'Alex', 'Aaron', 'Arthur', 'Fred', 'Rishi', 'Microsoft Guy', 'Microsoft David', 'Microsoft Mark', 'Male'],
    female: ['Google UK English Female', 'Samantha', 'Karen', 'Victoria', 'Moira', 'Tessa', 'Microsoft Aria', 'Microsoft Jenny', 'Microsoft Zira', 'Google US English', 'Female'],
  };
  const MALE_HINT = /\b(male|daniel|alex|aaron|arthur|fred|rishi|guy|david|mark|george|james|tom|oliver|lee|reed|ralph|gordon|eddy|rocko)\b/i;
  const FEMALE_HINT = /\b(female|samantha|karen|victoria|moira|tessa|aria|jenny|zira|susan|hazel|serena|fiona|kate|allison|ava|nicky|catherine|martha|libby|sonia|shelley|flo|sandy|google us english)\b/i;
  // macOS novelty voices: fun, but not for reading bars.
  const NOVELTY = /\b(albert|bad news|bahh|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|hysterical)\b/i;
  let voices = [];
  function loadVoices() {
    if (window.speechSynthesis) voices = window.speechSynthesis.getVoices() || [];
  }
  if (window.speechSynthesis) {
    loadVoices();
    window.speechSynthesis.addEventListener('voiceschanged', loadVoices);
  }
  function pickVoice(gender) {
    if (!voices.length) loadVoices();
    const en = voices.filter((v) => /^en([-_]|$)/i.test(v.lang) && !NOVELTY.test(v.name));
    const wants = gender === 'female' ? FEMALE_HINT : MALE_HINT;
    const avoid = gender === 'female' ? MALE_HINT : FEMALE_HINT;
    for (const name of VOICE_PREFS[gender] || []) {
      const v = en.find((x) => x.name.toLowerCase().includes(name.toLowerCase()) && !(name.length < 7 && avoid.test(x.name)));
      if (v) return v;
    }
    return en.find((v) => wants.test(v.name) && !avoid.test(v.name)) || en.find((v) => !avoid.test(v.name)) || en[0] || null;
  }
  const ttsLog = [];
  function duck(on) {
    if (!duckGain || !ac) return;
    duckGain.gain.setTargetAtTime(on ? 0.6 : 1, ac.currentTime, 0.08);
  }
  // Each line's voice is timed off the beat clock with timers (not animation frames, so it still
  // speaks in a background tab): a rough timer to just before the bar, then a precise one onto it.
  // Rescheduled whenever the beat is re-anchored.
  function scheduleSpeech() {
    stage.ttsTimers.forEach((t) => clearTimeout(t));
    stage.ttsTimers = [];
    if (!stage.wb || !stage.turn || stage.turn.voice === 'self' || !window.speechSynthesis) return;
    const msTo = (k) => (k * LINE_BEATS - beatPos()) * stage.beatSec * 1000;
    for (let k = 0; k < WB_LINES; k++) {
      if (stage.ttsQueued[k]) continue;
      const turn = stage.turn;
      stage.ttsTimers.push(setTimeout(() => {
        if (stage.turn !== turn || stage.ttsQueued[k]) return;
        const ahead = msTo(k);
        if (ahead < -stage.beatSec * 1000) return; // joined too late for this line
        stage.ttsTimers.push(setTimeout(() => {
          if (stage.turn !== turn || stage.ttsQueued[k]) return;
          stage.ttsQueued[k] = true;
          speakLine(k);
        }, Math.max(0, ahead)));
      }, Math.max(0, msTo(k) - 300)));
    }
  }

  function speakLine(k) {
    const synth = window.speechSynthesis;
    const turn = stage.turn;
    if (!synth || !turn || !stage.wb) return;
    synth.cancel();
    const text = turn.lines[k];
    if (!text) return;
    const u = new SpeechSynthesisUtterance(text);
    const voice = pickVoice(turn.voiceGender);
    if (voice) {
      u.voice = voice;
      u.lang = voice.lang;
    }
    // A line has 2 bars (~5.3 s at 90 BPM): speed up long ones.
    const words = text.split(/\s+/).filter(Boolean).length;
    u.rate = Math.min(1.5, 1.05 + Math.max(0, words - 9) * 0.06);
    u.onstart = () => duck(true);
    u.onend = () => duck(false);
    u.onerror = () => duck(false);
    synth.speak(u);
    ttsLog.push({ k: k + 1, text, gender: turn.voiceGender, voice: voice ? voice.name : '(default)', rate: u.rate, beat: beatPos(), at: performance.now() });
  }
  function stopSpeech() {
    stage.ttsTimers.forEach((t) => clearTimeout(t));
    stage.ttsTimers = [];
    if (stage.wb && window.speechSynthesis) window.speechSynthesis.cancel();
    duck(false);
  }

  function stopStage() {
    stopSpeech();
    if (stage.raf) cancelAnimationFrame(stage.raf);
    stage.raf = null;
    stopTrack(0.25);
    stage.turn = null;
    stage.audioStart = null;
    $('debug-info').hidden = true;
    hideOverlays();
    updateNudge();
  }

  // Fades out whatever's playing for this turn (quickly; the track's own tail fade is scheduled).
  function stopTrack(fade = 0.05) {
    const audio = stage.audio;
    stage.audio = null;
    if (!audio || !ac) return;
    const t = ac.currentTime;
    audio.gain.gain.cancelScheduledValues(t);
    audio.gain.gain.setValueAtTime(audio.gain.gain.value, t);
    audio.gain.gain.linearRampToValueAtTime(0.0001, t + fade);
    if (audio.src) { try { audio.src.stop(t + fade + 0.02); } catch { /* already stopped */ } }
    if (audio.synth) audio.synth.stop(t, true);
    audio.clicks.forEach((o) => { try { o.stop(); } catch { /* done */ } });
    setTimeout(() => { try { audio.gain.disconnect(); } catch { /* gone */ } }, (fade + 0.5) * 1000);
  }

  // Schedules this turn's track (and the count-in ticks) on the audio clock. The file plays once from
  // its intro bar 1 (offset + skipBars) so bar n lands at start + (n - 1) * barSeconds, and fades out
  // from fadeAfterBars. Called again if the audio only starts later (the browser needed a tap) or the
  // clock estimate improves; the track then picks up part-way through.
  function anchorAudio() {
    stopTrack();
    stage.audioStart = null;
    stage.anchoredOffset = offsetMs();
    const a = getAudioCtx();
    updateNudge();
    if (!a || a.state !== 'running' || !stage.turn) return;
    loadTracks();
    const track = stage.track;
    const lead = (localStartMs() - localNow()) / 1000;
    stage.audioStart = audioNow() + lead;
    // audioNow() is what's coming out of the speakers; schedule ahead by the output latency so the
    // track is heard right on time.
    const start = stage.audioStart + Math.max(0, a.currentTime - audioNow());
    const fadeT = start + Tracks.fadeAt(track, stage.turn.fadeAfterBars);
    if (a.currentTime >= fadeT + Tracks.FADE_SEC) return;
    const gain = a.createGain();
    gain.connect(musicGain);
    const fadeFrom = Math.max(a.currentTime, fadeT);
    gain.gain.setValueAtTime(1, fadeFrom);
    gain.gain.linearRampToValueAtTime(0.0001, fadeFrom + Tracks.FADE_SEC);
    const audio = { gain, src: null, synth: null, clicks: [], start }; // start: audio time of intro bar 1
    stage.audio = audio;
    const play = (buffer) => {
      if (stage.audio !== audio) return;
      const now = a.currentTime + 0.02;
      const from = Tracks.playbackOffset(track);
      const src = a.createBufferSource();
      src.buffer = buffer;
      src.connect(gain);
      if (start >= now) src.start(start, from);
      else src.start(now, from + (now - start));
      src.stop(fadeFrom + Tracks.FADE_SEC + 0.05);
      audio.src = src;
    };
    const fallback = () => {
      if (stage.audio !== audio) return;
      const synth = Beats.createBeat(a, gain, track.bpm < 100 ? 'boombap' : 'trap', { bpm: track.bpm, introBars: track.introBars });
      synth.start(start);
      synth.stop(start + Tracks.turnSeconds(track, stage.rapBars), false, 0.6);
      audio.synth = synth;
    };
    const pending = trackBuffers.get(track.id);
    if (pending && pending.buffer) play(pending.buffer);
    else if (pending && !pending.failed) pending.then(play, fallback);
    else fallback();
    // Count-in ticks over the last two intro bars.
    for (let i = 0; i < COUNT_IN; i++) {
      const t = start + (stage.introBeats - COUNT_IN + i) * stage.beatSec;
      if (t > a.currentTime) sfx.count(t, i === COUNT_IN - 1);
    }
    if (DEBUG_CLICK) {
      const beats = (track.introBars + stage.rapBars) * BPB;
      for (let k = 0; k < beats; k++) {
        const t = start + k * stage.beatSec;
        if (t > a.currentTime) sfx.click(t, k % BPB === 0);
      }
    }
    scheduleSpeech();
  }

  // Beats since the first rap bar started (negative during the intro).
  function beatPos() {
    if (stage.audioStart !== null && ac && ac.state === 'running') {
      return (audioNow() - stage.audioStart) / stage.beatSec - stage.introBeats;
    }
    return (localNow() - localStartMs()) / (stage.beatSec * 1000) - stage.introBeats;
  }

  function updateNudge() {
    const need = !!stage.turn && (!ac || ac.state !== 'running') && $('game-view').style.display === 'flex';
    $('sound-nudge').classList.toggle('show', need);
  }
  $('sound-nudge').addEventListener('click', () => {
    const a = getAudioCtx();
    if (a) a.resume().then(() => { if (stage.turn) anchorAudio(); updateNudge(); });
  });

  // Row k places: 0 is the current bar at the top, 1-3 are coming up, below that they're hidden,
  // and finished bars slide up and fade away.
  function updateRows(bar) {
    stage.currentBar = bar;
    stage.rows.forEach((row, i) => {
      const k = i - bar;
      row.classList.toggle('current', k === 0);
      row.classList.toggle('next', k >= 1 && k <= 2);
      row.classList.toggle('far', k >= 3);
      let y = `calc(${k} * (100% + var(--row-gap)))`;
      let scale = k === 0 ? 1 : 0.96;
      let opacity = k < 0 ? 0 : k <= 3 ? [1, 0.85, 0.6, 0.35][k] : 0;
      if (k < 0) {
        y = `calc(-100% - var(--row-gap) * 2)`;
        scale = 0.9;
      }
      row.style.transform = `translateY(${y}) scale(${scale})`;
      row.style.opacity = opacity;
      if (k !== 0) row.querySelectorAll('.cell').forEach((c) => c.classList.remove('hit'));
    });
  }

  // Where the four beat cells of the top row are, in canvas pixels (measured on an invisible copy of
  // the top row, so the sliding animation doesn't throw it off).
  function measure() {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.offsetWidth;
    const h = canvas.offsetHeight;
    if (!w || !h) return null;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const crect = canvas.getBoundingClientRect();
    const sx = w / crect.width;
    const sy = h / crect.height;
    const cells = [...stage.ghost.querySelectorAll('.cell')];
    const rects = cells.map((c) => c.getBoundingClientRect());
    const cx = rects.map((r) => (r.left + r.width / 2 - crect.left) * sx);
    const top = (rects[0].top - crect.top) * sy;
    const rowH = rects[0].height * sy;
    const r = Math.max(9, Math.min(22, rowH * 0.17));
    stage.geometry = { dpr, w, h, cx, top, rowH, r, arc: Math.min(top - r * 2.6, rowH * 0.85) };
    return stage.geometry;
  }
  window.addEventListener('resize', () => { stage.geometry = null; });

  function ballAt(p) {
    const g = stage.geometry;
    const land = g.top - g.r;
    if (p < -stage.introBeats) return null;
    if (p < 0) {
      // Intro and count-in: bounce on the spot over the first cell.
      const f = p - Math.floor(p);
      return { x: g.cx[0], y: land - g.arc * 0.6 * 4 * f * (1 - f), f, alpha: 1 };
    }
    if (p >= TOTAL_BEATS - 1) {
      // The last word: rest on it and fade.
      const fade = Math.max(0, 1 - (p - (TOTAL_BEATS - 1)) / 1.5);
      return fade > 0 ? { x: g.cx[3], y: land, f: 0, alpha: fade } : null;
    }
    const b = Math.floor(p);
    const f = p - b;
    const from = b % BPB;
    const to = (b + 1) % BPB;
    const arc = to === 0 ? g.arc * 1.2 : g.arc;
    return { x: g.cx[from] + (g.cx[to] - g.cx[from]) * f, y: land - arc * 4 * f * (1 - f), f, alpha: 1 };
  }

  function drawBall(p, now) {
    const g = stage.geometry || measure();
    if (!g) return;
    cctx.setTransform(g.dpr, 0, 0, g.dpr, 0, 0);
    cctx.clearRect(0, 0, g.w, g.h);
    const ball = ballAt(p);
    stage.trail = stage.trail.filter((pt) => now - pt.t < 220);
    if (!ball) return;
    stage.trail.push({ x: ball.x, y: ball.y, t: now });
    // Motion streak: a tapered, fading tail along the recent path.
    const pts = stage.trail;
    for (let i = 1; i < pts.length; i++) {
      const k = i / pts.length;
      cctx.strokeStyle = `rgba(139, 197, 64, ${0.14 * k * ball.alpha})`;
      cctx.lineWidth = g.r * 1.6 * k;
      cctx.lineCap = 'round';
      cctx.beginPath();
      cctx.moveTo(pts[i - 1].x, pts[i - 1].y);
      cctx.lineTo(pts[i].x, pts[i].y);
      cctx.stroke();
    }
    // Squash on landing, stretch on take-off.
    const near = Math.min(ball.f, 1 - ball.f);
    const squash = near < 0.1 ? 1 - (0.1 - near) * 2.2 : 1;
    cctx.save();
    cctx.globalAlpha = ball.alpha;
    cctx.translate(ball.x, ball.y + g.r);
    cctx.scale(2 - squash, squash);
    cctx.shadowColor = 'rgba(139, 197, 64, 0.9)';
    cctx.shadowBlur = 22;
    const grad = cctx.createRadialGradient(-g.r * 0.35, -g.r * 1.35, g.r * 0.15, 0, -g.r, g.r);
    grad.addColorStop(0, '#eaffd0');
    grad.addColorStop(0.35, '#8BC540');
    grad.addColorStop(1, '#3b6d1c');
    cctx.fillStyle = grad;
    cctx.beginPath();
    cctx.arc(0, -g.r, g.r, 0, Math.PI * 2);
    cctx.fill();
    cctx.restore();
  }

  function frame(now) {
    stage.raf = requestAnimationFrame(frame);
    if (!stage.turn) return;
    // A better clock estimate arrived mid-turn (e.g. just joined): line the beat up again.
    if (!stage.solo && Math.abs(net.clockOffset - stage.anchoredOffset) > 40 && beatPos() < stage.rapBeats - 4) anchorAudio();
    const p = beatPos();

    $('ready-overlay').classList.toggle('show', p < -COUNT_IN && !['vote-overlay', 'score-overlay', 'standings-overlay'].some((id) => $(id).classList.contains('show')));

    // Count-in: 8 down to 1 over the last two intro bars.
    if (p >= -COUNT_IN && p < 0) {
      const i = Math.floor(p) + COUNT_IN;
      if (i !== stage.countShown) {
        stage.countShown = i;
        const el = $('count');
        el.textContent = COUNT_WORDS[i];
        el.className = 'count';
        void el.offsetWidth;
        el.classList.add('pop');
        if (!stage.audioStart && ac && ac.state === 'running') sfx.count(ac.currentTime, i === COUNT_IN - 1);
      }
    }

    if (stage.wb) performanceFrame(p);
    else freestyleFrame(p, now);
    const done = p >= stage.rapBeats;
    if (done !== stage.ended) {
      stage.ended = done;
      $('mic-drop').style.display = done ? 'flex' : 'none';
      if (done && p < stage.rapBeats + 2) playClap();
    }
    if (DEBUG) showDebugInfo(p);
    if (stage.solo && !stage.soloDone && p >= TOTAL_BEATS + 1.5) {
      stage.soloDone = true;
      $('solo-overlay').classList.add('show');
    }
  }

  // Write Bars: line k (0-3) drops on the downbeat of performance bar 2k + 1, with the robot voice on it.
  function performanceFrame(p) {
    const line = p < 0 ? -1 : Math.min(WB_LINES - 1, Math.floor(p / LINE_BEATS));
    if (line !== stage.wbLine && p < stage.rapBeats) {
      stage.wbLine = line;
      stage.lineEls.forEach((el, i) => {
        el.classList.toggle('shown', i <= line);
        el.classList.toggle('current', i === line);
      });
      if (line >= 0) stage.lineLog.push({ k: line + 1, lateMs: Math.round((p - line * LINE_BEATS) * stage.beatSec * 1000 * 10) / 10, audio: !!stage.audioStart });
    }
    if (p >= stage.rapBeats && stage.wbLine !== 'done') {
      stage.wbLine = 'done';
      stage.lineEls.forEach((el) => { el.classList.add('shown'); el.classList.remove('current'); });
    }
    const beatIdx = p < 0 || p >= stage.rapBeats ? null : Math.floor(p);
    if (beatIdx !== stage.wbBeat) {
      stage.wbBeat = beatIdx;
      $('wb-beats').querySelectorAll('i').forEach((d, j) => {
        d.classList.toggle('lit', beatIdx !== null && j <= beatIdx % BPB);
        d.classList.toggle('down', beatIdx !== null && j === 0);
      });
    }
    const introBar = Math.floor((p + stage.introBeats) / BPB) + 1;
    $('bar-count').innerHTML = p < 0 ? `Intro <b>${Math.max(1, introBar)}</b> / ${stage.track.introBars}` : p < stage.rapBeats ? `Line <b>${line + 1}</b> / ${WB_LINES}` : `<b>${WB_LINES}</b> / ${WB_LINES}`;
  }

  function freestyleFrame(p, now) {
    const bar = p < 0 ? 0 : Math.min(BARS, Math.floor(p / BPB));
    if (bar !== stage.currentBar) updateRows(bar);
    const beatIdx = p < 0 ? null : Math.floor(p);
    if (beatIdx !== stage.lastBeat && beatIdx !== null && beatIdx < TOTAL_BEATS) {
      const row = stage.rows[bar];
      const inBar = beatIdx % BPB;
      if (row) {
        const cells = row.querySelectorAll('.cell');
        cells.forEach((c, j) => c.classList.toggle('lit', j <= inBar));
        const hit = cells[inBar];
        hit.classList.remove('hit');
        void hit.offsetWidth;
        hit.classList.add('hit');
      }
    }
    stage.lastBeat = beatIdx;

    const introBar = Math.floor((p + stage.introBeats) / BPB) + 1;
    $('bar-count').innerHTML = p < 0 ? `Intro <b>${Math.max(1, introBar)}</b> / ${stage.track.introBars}` : p < TOTAL_BEATS ? `Bar <b>${bar + 1}</b> / ${BARS}` : `<b>${BARS}</b> / ${BARS}`;
    drawBall(p, now);
  }

  // ?debug: the track's timing on screen (add &click for a metronome over the track).
  function showDebugInfo(p) {
    const t = stage.track;
    const el = $('debug-info');
    el.hidden = false;
    const trackBar = Math.floor((p + stage.introBeats) / BPB) + 1;
    const beat = Math.floor(((p % BPB) + BPB) % BPB) + 1;
    const pending = trackBuffers.get(t.id);
    const source = stage.audio && stage.audio.synth ? 'synth fallback' : pending && pending.buffer ? 'mp3' : 'loading';
    const fadeAfter = (stage.turn && stage.turn.fadeAfterBars) || t.fadeAfterBars;
    el.textContent = `${t.name} (${t.id}) · ${t.bpm} BPM · offset ${t.offset}s · skipBars ${t.skipBars} · fadeAfterBars ${fadeAfter}${stage.wb ? ' · Write Bars' : ''}\n`
      + `track bar ${trackBar} beat ${beat} · rap pos ${p.toFixed(2)} beats · ${source}${DEBUG_CLICK ? ' · click on' : ' · add &click for a metronome'}`;
  }

  // Debug aid: ?debug exposes the client state.
  if (DEBUG) window.__rapmatesDebug = { state, stage, net, beatPos, getAudioCtx, trackBuffers, ttsLog, pickVoice, write };

  buildSlots();
  renderSlots();
  enterRoomFromUrl();
})();
