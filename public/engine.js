// Authoritative Rapmates room logic: up to 4 rappers take turns spitting 16 bars over the room's beat,
// everybody else in the room (other rappers and the crowd) rates each turn out of 5 stars, and the
// best average takes the mic. Runs in the host's browser (window.RapmatesEngine) and in Node for tests
// (require). It knows nothing about networking: the caller supplies broadcast(event, data) and
// send(playerId, event, data).
//
// Timing: the room never streams the beat. Each turn is a schedule in the host's clock (now()):
// startAt (the count-in's first beat), the tempo and the turn's rhyme pairs. Every browser converts
// startAt into its own audio clock and plays the beat and the bouncing ball locally (see client.js).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./words.js'));
  else root.RapmatesEngine = factory(root.RapmatesWords);
})(typeof self !== 'undefined' ? self : this, (Words) => {
  const TICK_RATE = 10; // phase checks per second; turns themselves are absolute timestamps
  const MAX_PLAYERS = 4;
  const BARS = Words.BARS_PER_TURN; // 16
  const BEATS_PER_BAR = Words.BEATS_PER_BAR; // 4
  const COUNT_IN_BEATS = 4; // "3, 2, 1, GO!" on the beat before bar 1
  const LEAD_MS = 3500; // "Get ready" card before the count-in (also covers network delay)
  const VOTE_SECONDS = 20;
  const SCORE_MS = 4500; // how long a rapper's average is shown before the next turn
  const BEATS = { trap: { bpm: 130 }, boombap: { bpm: 90 } };
  const DEFAULT_BEAT = 'trap';
  const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O to avoid confusion with 1/0
  const PLAYER_COLORS = ['#EF5B54', '#4796D1', '#F29D38', '#61A532'];
  // Real rapper names, half men and half women, handed out at random (unique within a room).
  const MALE_NAMES = [
    'Gucci Mane', 'Drake', 'Biggie', 'Juicy J', 'Killer Mike', 'Quavo', 'Big Lurch', 'Violent J', 'Yung Lean',
    'Lil Wayne', 'RZA', 'GZA', 'Xzibit', 'MF Doom', 'Snoop Dogg', 'Kendrick Lamar', 'Ice Cube', 'Nas',
  ];
  const FEMALE_NAMES = [
    'Lil Kim', 'Missy Elliott', 'Doja Cat', 'Cardi B', 'Nicki Minaj', 'Queen Latifah', 'Lauryn Hill',
    'Megan Thee Stallion', 'Lizzo', 'Eve', 'Rapsody', 'Latto', 'Ice Spice', 'Salt', 'Da Brat', 'Remy Ma',
    'Foxy Brown', 'MC Lyte',
  ];
  const RAP_NAMES = [...MALE_NAMES, ...FEMALE_NAMES];

  const randInt = (n, random = Math.random) => Math.floor(random() * n);
  const round2 = (x) => Math.round(x * 100) / 100;

  function generateRoomCode(isTaken = () => false) {
    for (let attempt = 0; attempt < 1000; attempt++) {
      let code = '';
      for (let i = 0; i < 4; i++) code += ROOM_CODE_ALPHABET[randInt(ROOM_CODE_ALPHABET.length)];
      if (!isTaken(code)) return code;
    }
    throw new Error('Unable to allocate a unique room code');
  }

  // Milliseconds from the start of a turn (startAt) to the end of its 16th bar.
  const turnLengthMs = (bpm) => ((COUNT_IN_BEATS + BARS * BEATS_PER_BAR) * 60000) / bpm;

  // Ranks rappers by average stars (no votes counts as lowest); everyone tied on the top average wins.
  function standingsOf(results) {
    const standings = results.slice().sort((a, b) => (b.average ?? -1) - (a.average ?? -1) || a.number - b.number);
    const top = standings.length ? standings[0].average : null;
    const winnerIds = top === null || top === undefined ? [] : standings.filter((r) => r.average === top).map((r) => r.id);
    return { standings, winnerIds };
  }

  class GameRoom {
    /**
     * @param {string} code room code
     * @param {object} hooks broadcast(event, data), send(playerId, event, data), optional
     *   setInterval/clearInterval, random (pair draws) and now() (the host clock, ms)
     */
    constructor(code, hooks) {
      this.code = code;
      this.broadcast = hooks.broadcast;
      this.send = hooks.send;
      this.setInterval = hooks.setInterval || ((fn, ms) => setInterval(fn, ms));
      this.clearInterval = hooks.clearInterval || ((id) => clearInterval(id));
      this.random = hooks.random || Math.random;
      this.now = hooks.now || (() => Date.now());
      this.leadMs = hooks.leadMs ?? LEAD_MS;
      this.hostId = null;
      this.members = new Map(); // id -> { id, role: 'player'|'crowd', number, name, color, seq }
      this.seq = 0;
      this.beat = DEFAULT_BEAT;
      this.bpm = BEATS[DEFAULT_BEAT].bpm;
      this.started = false;
      this.loop = null;
      this.round = 0;
      this.phase = null; // 'turn' | 'vote' | 'score' | 'results' | null
      this.order = []; // rapper ids for this game, P1 first
      this.turnIndex = -1;
      this.turn = null; // { rapperId, startAt, endAt, pairs }
      this.votes = new Map(); // voterId -> stars, for the current turn
      this.voteEndsAt = 0;
      this.scoreEndsAt = 0;
      this.results = []; // one entry per finished turn
      this.deck = [];
    }

    get size() {
      return this.members.size;
    }

    // Rappers (players with a P1-P4 slot), by number.
    get players() {
      return [...this.members.values()].filter((m) => m.role === 'player').sort((a, b) => a.number - b.number);
    }

    get crowd() {
      return [...this.members.values()].filter((m) => m.role === 'crowd').sort((a, b) => a.seq - b.seq);
    }

    pickName(preferredName) {
      const used = new Set([...this.members.values()].map((m) => m.name));
      if (preferredName && !used.has(preferredName) && RAP_NAMES.includes(preferredName)) return preferredName;
      const free = RAP_NAMES.filter((n) => !used.has(n));
      if (free.length) return free[randInt(free.length)];
      // A very big crowd: number the names.
      for (let n = 2; ; n++) {
        const name = `${RAP_NAMES[randInt(RAP_NAMES.length)]} ${n}`;
        if (!used.has(name)) return name;
      }
    }

    // Adds a member without messaging anyone; call announceJoin() after acknowledging the joiner.
    // The first 4 get rapper slots; everyone after that joins the crowd (watches and votes).
    // preferredName keeps a name when moving to a new host after a handover.
    join(id, preferredName) {
      if (this.members.has(id)) return { ok: false, error: 'Already in this room.' };
      const players = this.players;
      const member = { id, name: this.pickName(preferredName), seq: ++this.seq };
      if (players.length < MAX_PLAYERS) {
        const taken = new Set(players.map((p) => p.number));
        let number = 1;
        while (taken.has(number)) number++;
        Object.assign(member, { role: 'player', number, color: PLAYER_COLORS[number - 1] });
      } else {
        Object.assign(member, { role: 'crowd', number: null, color: '#8a8a8a' });
      }
      this.members.set(id, member);
      if (!this.hostId) this.hostId = id;
      return { ok: true, payload: { playerId: id, ...this.lobbyPayload() } };
    }

    announceJoin(id) {
      this.broadcastLobby();
      if (this.started) this.send(id, 'gameStarted', this.gamePayload());
    }

    leave(id) {
      const leaver = this.members.get(id);
      if (!leaver) return;
      this.members.delete(id);
      if (this.members.size === 0) {
        this.destroy();
        return;
      }
      if (this.hostId === id) this.hostId = this.nextHostId();
      if (!this.started) this.fillSlots();
      if (this.started) {
        const rapperLeft = this.turn && this.turn.rapperId === id && (this.phase === 'turn' || this.phase === 'vote');
        if (rapperLeft) {
          this.nextTurn();
        } else if (this.phase === 'vote' && this.allVoted()) {
          this.closeVote();
        }
      }
      this.broadcastLobby();
    }

    // Between games, free rapper slots go to whoever's waited longest in the crowd.
    fillSlots() {
      for (let number = 1; number <= MAX_PLAYERS; number++) {
        if (this.players.some((p) => p.number === number)) continue;
        const promoted = this.crowd[0];
        if (!promoted) return;
        Object.assign(promoted, { role: 'player', number, color: PLAYER_COLORS[number - 1] });
      }
    }

    // Who takes over hosting: rappers in slot order, then the crowd in the order they arrived.
    nextHostId() {
      const next = this.players[0] || this.crowd[0];
      return next ? next.id : null;
    }

    // The host picks the beat in the lobby.
    setBeat(requesterId, beat) {
      if (requesterId !== this.hostId || this.started || !BEATS[beat]) return false;
      this.beat = beat;
      this.bpm = BEATS[beat].bpm;
      this.broadcastLobby();
      return true;
    }

    // The host starts (or restarts) the game. options.beat: 'trap' or 'boombap'; options.bpm lets the
    // host's beat file set the tempo (60-200).
    start(requesterId, options = {}) {
      if (this.started || requesterId !== this.hostId) return false;
      if (!this.players.length) return false;
      const opts = options && typeof options === 'object' ? options : {};
      if (BEATS[opts.beat]) this.beat = opts.beat;
      const bpm = Number(opts.bpm);
      this.bpm = Number.isFinite(bpm) && bpm >= 60 && bpm <= 200 ? bpm : BEATS[this.beat].bpm;
      this.round += 1;
      this.started = true;
      this.order = this.players.map((p) => p.id);
      this.results = [];
      this.deck = Words.shuffledIndexes(Words.PAIRS.length, this.random);
      this.turnIndex = -1;
      this.turn = null;
      this.beginTurn(0, false);
      this.broadcast('gameStarted', this.gamePayload());
      this.stopLoop();
      this.loop = this.setInterval(() => this.gameTick(), 1000 / TICK_RATE);
      return true;
    }

    /**
     * Input from anyone in the room:
     *   { type: 'vote', stars: 1-5, turn: turnIndex } rate the rapper whose turn just finished.
     *   The rapper can't vote for themselves; rappers and the crowd can vote for everyone else.
     */
    input(id, msg) {
      if (!this.started || !msg || typeof msg !== 'object') return false;
      if (msg.type !== 'vote') return false;
      return this.vote(id, msg.stars, msg.turn);
    }

    vote(id, stars, turnIndex = this.turnIndex) {
      if (this.phase !== 'vote' || !this.members.has(id) || !this.turn) return false;
      if (turnIndex !== undefined && turnIndex !== this.turnIndex) return false;
      if (id === this.turn.rapperId) return false;
      if (!Number.isInteger(stars) || stars < 1 || stars > 5) return false;
      this.votes.set(id, stars);
      if (this.allVoted()) this.closeVote();
      else this.broadcast('votes', this.serializeVotes());
      return true;
    }

    destroy() {
      this.stopLoop();
      this.started = false;
      this.phase = null;
    }

    // ---------- internals ----------

    eligibleVoters() {
      const rapper = this.turn && this.turn.rapperId;
      return [...this.members.keys()].filter((id) => id !== rapper);
    }

    allVoted() {
      const voters = this.eligibleVoters();
      return voters.every((id) => this.votes.has(id));
    }

    // Starts turn `index` (skipping rappers who've left). Ends the game when nobody's left to rap.
    beginTurn(index, announce = true) {
      while (index < this.order.length && !this.members.has(this.order[index])) index++;
      if (index >= this.order.length) {
        this.endGame();
        return;
      }
      if (this.deck.length < Words.PAIRS_PER_TURN) this.deck = Words.shuffledIndexes(Words.PAIRS.length, this.random);
      const pairs = this.deck.splice(0, Words.PAIRS_PER_TURN).map((i) => Words.PAIRS[i].slice());
      const startAt = this.now() + this.leadMs;
      this.turnIndex = index;
      this.turn = { rapperId: this.order[index], startAt, endAt: startAt + turnLengthMs(this.bpm), pairs };
      this.votes = new Map();
      this.phase = 'turn';
      if (announce) this.broadcast('phase', this.phasePayload());
    }

    nextTurn() {
      this.beginTurn(this.turnIndex + 1);
    }

    openVote() {
      this.phase = 'vote';
      this.votes = new Map();
      this.voteEndsAt = this.now() + VOTE_SECONDS * 1000;
      // Practising alone in a room: nobody to vote, carry on.
      if (!this.eligibleVoters().length) return this.closeVote();
      this.broadcast('phase', this.phasePayload());
    }

    closeVote() {
      const rapper = this.members.get(this.turn.rapperId);
      const stars = [...this.votes.values()];
      const average = stars.length ? round2(stars.reduce((a, b) => a + b, 0) / stars.length) : null;
      if (rapper) {
        this.results.push({ id: rapper.id, name: rapper.name, number: rapper.number, color: rapper.color, average, votes: stars.length });
      }
      this.phase = 'score';
      this.scoreEndsAt = this.now() + SCORE_MS;
      this.broadcast('phase', this.phasePayload());
    }

    gameTick() {
      if (!this.started) return;
      const now = this.now();
      if (this.phase === 'turn' && now >= this.turn.endAt) this.openVote();
      else if (this.phase === 'vote' && now >= this.voteEndsAt) this.closeVote();
      else if (this.phase === 'score' && now >= this.scoreEndsAt) this.nextTurn();
    }

    endGame() {
      this.stopLoop();
      this.started = false;
      this.phase = 'results';
      this.turn = null;
      this.fillSlots();
      this.broadcast('gameOver', { round: this.round, beat: this.beat, ...standingsOf(this.results) });
      this.broadcastLobby();
    }

    serializeMember(m) {
      return { id: m.id, role: m.role, number: m.number, name: m.name, color: m.color };
    }

    serializeVotes() {
      const voters = this.eligibleVoters();
      return { turnIndex: this.turnIndex, count: voters.filter((id) => this.votes.has(id)).length, needed: voters.length, voted: [...this.votes.keys()] };
    }

    phasePayload() {
      const p = { phase: this.phase, turnIndex: this.turnIndex, turns: this.order.length, now: this.now() };
      if (this.turn) {
        const rapper = this.members.get(this.turn.rapperId);
        p.turn = { ...this.turn, pairs: this.turn.pairs.map((pair) => pair.slice()), name: rapper ? rapper.name : '', color: rapper ? rapper.color : '#fff' };
      }
      if (this.phase === 'vote') Object.assign(p, { voteEndsAt: this.voteEndsAt, votes: this.serializeVotes() });
      if (this.phase === 'score') Object.assign(p, { scoreEndsAt: this.scoreEndsAt, result: this.results[this.results.length - 1] || null });
      return p;
    }

    lobbyPayload() {
      return {
        roomCode: this.code,
        hostId: this.hostId,
        started: this.started,
        beat: this.beat,
        players: this.players.map((m) => this.serializeMember(m)),
        crowd: this.crowd.map((m) => this.serializeMember(m)),
      };
    }

    gamePayload() {
      return {
        round: this.round,
        beat: this.beat,
        bpm: this.bpm,
        order: this.order.slice(),
        results: this.results.slice(),
        ...this.phasePayload(),
        ...this.lobbyPayload(),
      };
    }

    broadcastLobby() {
      this.broadcast('lobbyUpdate', this.lobbyPayload());
    }

    stopLoop() {
      if (this.loop !== null) this.clearInterval(this.loop);
      this.loop = null;
    }
  }

  return {
    GameRoom,
    generateRoomCode,
    standingsOf,
    turnLengthMs,
    TICK_RATE,
    MAX_PLAYERS,
    BARS,
    BEATS_PER_BAR,
    COUNT_IN_BEATS,
    LEAD_MS,
    VOTE_SECONDS,
    SCORE_MS,
    BEATS,
    PLAYER_COLORS,
    RAP_NAMES,
    MALE_NAMES,
    FEMALE_NAMES,
  };
});
