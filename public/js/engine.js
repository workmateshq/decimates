// Authoritative Decimates room logic: a head-to-head joke-writing party game.
//
// Rounds 1 and 2: the host deals prompts in a ring, so every prompt goes to exactly 2 players and every
// player answers exactly 2 prompts. Everyone writes at once (90 seconds), then each prompt is a matchup:
// the prompt, then the two (anonymous) answers, then everyone except the two authors votes for their
// favourite, then the reveal (authors, the vote split, points; the winner's dynamite explodes).
// Round 3 (the final): everyone answers the same prompt and votes for up to 3 favourites. About 1 game in 3
// the final is "Caption this comic" with a public domain Buck Ryan strip.
// Points = votes received x 100 x round; a clean sweep (every vote) earns a bonus. After rounds 1 and 2
// a scoreboard waits for players to opt in to the next round. Like Rapmates, a room can play with 1 to 8:
// when nobody else can vote on a matchup it's a practice reveal (every answer goes off, no points).
//
// Runs in the host's browser (window.DecimatesEngine) and in Node for tests (require). It knows nothing
// about networking: the caller supplies broadcast(event, data) and send(playerId, event, data). Every
// deadline is on the host's clock (now()).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./prompts.js'));
  else root.DecimatesEngine = factory(root.DecimatesPrompts);
})(typeof self !== 'undefined' ? self : this, (Prompts) => {
  const TICK_RATE = 10; // phase checks per second
  const MAX_PLAYERS = 8;
  const MIN_PLAYERS = 1; // practise alone, or play with mates (votes need someone who didn't write it)
  const ROUNDS = 3; // round 3 is the final
  const PROMPTS_PER_PLAYER = 2;
  const WRITE_SECONDS = 90;
  const WRITE_GRACE_MS = 1000; // drafts sent as a player's clock hits 0 still count
  const ANSWER_MAX = 80; // characters per answer
  const NO_ANSWER = '(no answer)';
  const SHOW_MS = 9500; // the prompt, then answer A, OR, answer B, and a few seconds to read them before the vote
  const VOTE_SECONDS = 15;
  const FINAL_VOTE_SECONDS = 30;
  const FINAL_PICKS = 3; // votes each in the final
  const VOTES_IN_MS = 1500; // after the last vote lands, a beat so everyone sees it before the reveal
  const WINNER_VOS = 3; // sound/winner-vo-01..03.mp3, rotated by the host game by game (01, 02, 03, 01...)
  const REVEAL_MS = 8000; // authors, the vote split and the explosion
  const SWEEP_REVEAL_MS = 10000; // a little longer for a clean sweep
  const POINTS_PER_VOTE = 100; // x the round number
  const CLEAN_SWEEP_BONUS = 250;
  const STINGERS = 8; // end-of-matchup announcer lines, cycled (the host picks, so everyone hears the same one)
  const STANDINGS_MS = 5000; // the final scoreboard, before the podium
  const NEXT_ROUND_SECONDS = 30; // between rounds: players press "Play next round"; whoever has by then plays on
  const INTRO_MS = 30000; // the how-to-play screen (the 29 s voiceover, sound/intro-vo.mp3); the host can skip it
  const FINAL_INTRO_MS = 16500; // before the final: what's different (the 15.5 s voiceover, sound/final-round-vo.mp3)
  const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O to avoid confusion with 1/0
  // Cartoon paint-box colours, one per seat.
  const PLAYER_COLORS = ['#E8432E', '#2E7DD7', '#F5B400', '#3BA55C', '#9B59D0', '#EE7A1F', '#E64E9B', '#1FA9A0'];
  const NAME_MAX = 16; // characters in a player's name

  const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
  const cleanText = (text, max) => {
    if (typeof text !== 'string') return '';
    const clean = text.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
    return Array.from(clean).slice(0, max).join('').trim();
  };
  // A name as typed: no control characters, spaces collapsed, at most NAME_MAX characters.
  const sanitizeName = (name) => cleanText(name, NAME_MAX);
  // An answer as typed: the same, at most ANSWER_MAX characters.
  const sanitizeAnswer = (text) => cleanText(text, ANSWER_MAX);

  const randInt = (n, random = Math.random) => Math.floor(random() * n);

  function generateRoomCode(isTaken = () => false) {
    for (let attempt = 0; attempt < 1000; attempt++) {
      let code = '';
      for (let i = 0; i < 4; i++) code += ROOM_CODE_ALPHABET[randInt(ROOM_CODE_ALPHABET.length)];
      if (!isTaken(code)) return code;
    }
    throw new Error('Unable to allocate a unique room code');
  }

  // The ring deal: with N players and N prompts, player i gets prompts i and i+1 (mod N), so every prompt
  // has 2 authors and every player 2 prompts (alone: 2 prompts of your own). Returns { [playerId]: [promptIndex, promptIndex] }.
  function ringDeal(playerIds) {
    const n = playerIds.length;
    const deal = {};
    playerIds.forEach((id, i) => {
      deal[id] = n === 1 ? [0, 1] : [i, (i + 1) % n];
    });
    return deal;
  }

  // Points for one matchup. answers: [{ votes: n }]. Returns per-answer points, the winners (indexes; ties
  // share) and whether it was a clean sweep (a single winner with every vote, against at least 1 rival).
  function scoreMatchup(voteCounts, round, { sweepable = true } = {}) {
    const total = voteCounts.reduce((a, b) => a + b, 0);
    const points = voteCounts.map((v) => v * POINTS_PER_VOTE * round);
    if (!total) return { points, winners: [], cleanSweep: false };
    const top = Math.max(...voteCounts);
    const winners = voteCounts.map((v, i) => (v === top ? i : -1)).filter((i) => i >= 0);
    const cleanSweep = sweepable && voteCounts.length > 1 && winners.length === 1 && top === total;
    if (cleanSweep) points[winners[0]] += CLEAN_SWEEP_BONUS;
    return { points, winners, cleanSweep };
  }

  // Most points across the game; everyone tied on a top score above 0 wins.
  function standingsOf(totals) {
    const standings = totals.slice().sort((a, b) => b.total - a.total || a.number - b.number);
    const top = standings.length ? standings[0].total : 0;
    const winnerIds = top > 0 ? standings.filter((r) => r.total === top).map((r) => r.id) : [];
    return { standings, winnerIds };
  }

  class GameRoom {
    /**
     * @param {string} code room code
     * @param {object} hooks broadcast(event, data), send(playerId, event, data), optional
     *   setInterval/clearInterval, random (dealing), now() (the host clock, ms), maxPlayers, introMs
     */
    constructor(code, hooks) {
      this.code = code;
      this.broadcast = hooks.broadcast;
      this.send = hooks.send;
      this.setInterval = hooks.setInterval || ((fn, ms) => setInterval(fn, ms));
      this.clearInterval = hooks.clearInterval || ((id) => clearInterval(id));
      this.random = hooks.random || Math.random;
      this.now = hooks.now || (() => Date.now());
      this.introMs = hooks.introMs; // both intro screens' length (tests use 0 to skip them); default INTRO_MS / FINAL_INTRO_MS
      this.maxPlayers = Math.min(MAX_PLAYERS, hooks.maxPlayers || MAX_PLAYERS);
      this.hostId = null;
      this.members = new Map(); // id -> { id, role: 'player'|'crowd', number, name, color, seq }
      this.seq = 0;
      this.started = false;
      this.loop = null;
      this.game = 0; // games played in this room
      this.phase = null; // 'intro' | 'write' | 'matchup' | 'standings' | 'results' | null
      this.order = []; // player ids in this game, P1 first
      this.round = 0;
      this.deck = [];
      this.used = new Set(); // prompt indexes used this game
      this.entries = new Map(); // write phase: id -> { prompts: [promptIndex], answers: { promptIndex: text }, done }
      this.writeMs = WRITE_SECONDS * 1000;
      this.writeEndsAt = 0;
      this.matchups = []; // this round's matchups
      this.mu = -1; // current matchup index
      this.step = null; // 'show' | 'vote' | 'reveal'
      this.stepEndsAt = 0;
      this.totals = new Map(); // id -> { id, name, number, color, total }
      this.roundResults = [];
      this.nextReady = new Set();
      this.standingsEndsAt = 0;
      this.stingerCount = 0;
      this.finalRound = true;
    }

    get size() {
      return this.members.size;
    }

    // Players (with a P1-P8 slot), by number.
    get players() {
      return [...this.members.values()].filter((m) => m.role === 'player').sort((a, b) => a.number - b.number);
    }

    get crowd() {
      return [...this.members.values()].filter((m) => m.role === 'crowd').sort((a, b) => a.seq - b.seq);
    }

    // Everyone picks their own name; a clash gets a number ("Zak 2"), and no name becomes "Player".
    pickName(preferredName) {
      const used = new Set([...this.members.values()].map((m) => m.name.toLowerCase()));
      const base = sanitizeName(preferredName) || 'Player';
      if (!used.has(base.toLowerCase())) return base;
      for (let n = 2; ; n++) {
        const name = `${Array.from(base).slice(0, NAME_MAX - String(n).length - 1).join('').trim()} ${n}`;
        if (!used.has(name.toLowerCase())) return name;
      }
    }

    // Adds a member without messaging anyone; call announceJoin() after acknowledging the joiner.
    // Before a game the first 8 get player slots; everyone else (and anyone arriving mid-game) joins the crowd.
    join(id, preferredName) {
      if (this.members.has(id)) return { ok: false, error: 'Already in this room.' };
      const players = this.players;
      const member = { id, name: this.pickName(preferredName), seq: ++this.seq };
      if (!this.started && players.length < this.maxPlayers) {
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
      if (!this.members.get(id)) return;
      this.members.delete(id);
      if (this.members.size === 0) {
        this.destroy();
        return;
      }
      if (this.hostId === id) this.hostId = this.nextHostId();
      if (!this.started) this.fillSlots();
      else this.afterLeave();
      this.broadcastLobby();
    }

    // Someone left mid-game: don't wait for them.
    afterLeave() {
      if (this.phase === 'write') {
        if (this.allWritten()) this.beginMatchups();
        else this.broadcastPhase();
      } else if (this.phase === 'matchup' && this.step === 'vote') {
        if (this.allVoted()) this.votesIn();
        else this.broadcastPhase();
      } else if (this.phase === 'standings' && this.round < ROUNDS) {
        const left = this.nextRoundPlayers();
        if (left.length && left.every((id) => this.nextReady.has(id))) this.startNextRound();
        else this.broadcastPhase();
      }
    }

    // Between games, free player slots go to whoever's waited longest in the crowd.
    fillSlots() {
      for (let number = 1; number <= this.maxPlayers; number++) {
        if (this.players.some((p) => p.number === number)) continue;
        const promoted = this.crowd[0];
        if (!promoted) return;
        Object.assign(promoted, { role: 'player', number, color: PLAYER_COLORS[number - 1] });
      }
    }

    // Who takes over hosting: players in slot order, then the crowd in the order they arrived.
    nextHostId() {
      const next = this.players[0] || this.crowd[0];
      return next ? next.id : null;
    }

    // The host starts (or restarts) the game.
    // options.writeSeconds: a shorter write timer (testing); options.intro === false skips the intro;
    // options.minPlayers: fewer players for testing alone (?debug&min=1).
    start(requesterId, options = {}) {
      if (this.started || requesterId !== this.hostId) return false;
      const min = Number.isFinite(options.minPlayers) ? Math.max(1, options.minPlayers) : MIN_PLAYERS;
      if (this.players.length < min) return false;
      this.game += 1;
      this.started = true;
      this.order = this.players.map((p) => p.id);
      this.round = 0;
      this.deck = Prompts.shuffledIndexes(Prompts.PROMPTS.length, this.random);
      this.used = new Set();
      this.totals = new Map(this.players.map((m) => [m.id, { id: m.id, name: m.name, number: m.number, color: m.color, total: 0 }]));
      this.roundResults = [];
      this.finalRound = options.finalRound !== false;
      // options.comicFinal: force (true) or rule out (false) the comic final; otherwise about 1 game in 3.
      this.comicFinal = typeof options.comicFinal === 'boolean' ? options.comicFinal : this.random() < Prompts.COMIC_CHANCE;
      const secs = Number.isFinite(options.writeSeconds) ? Math.max(5, Math.min(WRITE_SECONDS, options.writeSeconds)) : WRITE_SECONDS;
      this.writeMs = secs * 1000;
      this.introsOn = options.intro !== false;
      if (this.introLength('rules') > 0) {
        this.beginIntro('rules', false);
      } else {
        this.beginWrite(false);
      }
      this.broadcast('gameStarted', this.gamePayload());
      this.stopLoop();
      this.loop = this.setInterval(() => this.gameTick(), 1000 / TICK_RATE);
      return true;
    }

    /**
     * Input from anyone in the room:
     *   { type: 'skipIntro' } the host skips the intro screen.
     *   { type: 'answer', promptId, text } a player's answer so far (promptId: the prompt's index).
     *   { type: 'done' } lock in your answers; { type: 'edit' } unlock them (while others are still writing).
     *   { type: 'vote', matchup, choice: 'a'|'b' } vote in a head-to-head matchup (not your own).
     *   { type: 'vote', matchup, choices: [answerIndex, ...] } the final: up to 3 answers (not your own).
     *   { type: 'nextRound', round } opt in to the next round from the scoreboard.
     */
    input(id, msg) {
      if (!msg || typeof msg !== 'object' || !this.started) return false;
      if (msg.type === 'skipIntro') return this.skipIntro(id);
      if (msg.type === 'answer') return this.answer(id, msg.promptId, msg.text);
      if (msg.type === 'done') return this.setDone(id, true);
      if (msg.type === 'edit') return this.setDone(id, false);
      if (msg.type === 'vote') return this.vote(id, msg);
      if (msg.type === 'nextRound') return this.readyNextRound(id, msg.round);
      return false;
    }

    introLength(kind) {
      if (!this.introsOn) return 0;
      return this.introMs ?? (kind === 'final' ? FINAL_INTRO_MS : INTRO_MS);
    }

    // An intro screen: 'rules' (how to play, at the start) or 'final' (before the final round).
    beginIntro(kind, announce = true) {
      this.phase = 'intro';
      this.introKind = kind;
      this.introStartedAt = this.now();
      this.introEndsAt = this.introStartedAt + this.introLength(kind);
      if (announce) this.broadcastPhase();
    }

    skipIntro(id) {
      if (this.phase !== 'intro' || id !== this.hostId) return false;
      this.beginWrite();
      return true;
    }

    destroy() {
      this.stopLoop();
      this.started = false;
      this.phase = null;
    }

    // ---------- Writing ----------

    get isFinal() {
      return this.finalRound && this.round === ROUNDS;
    }

    drawPrompt() {
      if (!this.deck.length) this.deck = Prompts.shuffledIndexes(Prompts.PROMPTS.length, this.random).filter((i) => !this.used.has(i));
      const i = this.deck.shift();
      this.used.add(i);
      return i;
    }

    // A new round: fresh prompts dealt in a ring (or one shared prompt in the final) and the clock starts.
    beginWrite(announce = true) {
      const writers = this.order.filter((id) => this.members.has(id));
      if (!writers.length) return this.endGame();
      this.round += 1;
      if (this.isFinal) {
        // Comics come from a shuffled deck, so none repeats until every strip has had a go.
        if (this.comicFinal && !(this.comicDeck && this.comicDeck.length)) this.comicDeck = Prompts.shuffledIndexes(Prompts.COMICS.length, this.random);
        const p = this.comicFinal ? `comic:${this.comicDeck.shift()}` : this.drawPrompt();
        this.entries = new Map(writers.map((id) => [id, { prompts: [p], answers: {}, done: false }]));
      } else {
        const prompts = Array.from({ length: Math.max(PROMPTS_PER_PLAYER, writers.length) }, () => this.drawPrompt());
        const deal = ringDeal(writers);
        this.entries = new Map(writers.map((id) => [id, { prompts: deal[id].map((k) => prompts[k]), answers: {}, done: false }]));
      }
      this.matchups = [];
      this.mu = -1;
      this.step = null;
      this.writeEndsAt = this.now() + this.writeMs;
      this.phase = 'write';
      if (announce) this.broadcastPhase();
    }

    answer(id, promptId, text) {
      if (this.phase !== 'write') return false;
      const e = this.entries.get(id);
      if (!e || e.done || !e.prompts.includes(promptId)) return false;
      e.answers[promptId] = sanitizeAnswer(text);
      return true;
    }

    setDone(id, done) {
      if (this.phase !== 'write') return false;
      const e = this.entries.get(id);
      if (!e || e.done === done) return false;
      e.done = done;
      if (done && this.allWritten()) this.beginMatchups();
      else this.broadcastPhase();
      return true;
    }

    allWritten() {
      const here = [...this.entries.keys()].filter((id) => this.members.has(id));
      return here.length > 0 && here.every((id) => this.entries.get(id).done);
    }

    // ---------- Matchups ----------

    // Every prompt this round becomes a matchup, in deal order; answer order is shuffled so A isn't always
    // the same seat. Missing answers become "(no answer)".
    beginMatchups() {
      const byPrompt = new Map();
      this.entries.forEach((e, id) => {
        e.prompts.forEach((p) => {
          if (!byPrompt.has(p)) byPrompt.set(p, []);
          byPrompt.get(p).push({ author: id, text: e.answers[p] || '' });
        });
      });
      this.matchups = [...byPrompt.entries()].map(([prompt, answers]) => {
        const shuffled = Prompts.shuffledIndexes(answers.length, this.random).map((i) => answers[i]);
        return {
          prompt,
          final: this.isFinal,
          answers: shuffled.map((a) => ({ author: a.author, text: a.text || NO_ANSWER, empty: !a.text, voters: [] })),
          votes: new Map(), // voterId -> [answerIndex, ...]
          result: null,
          stinger: 0,
        };
      });
      this.phase = 'matchup';
      this.beginMatchup(0);
    }

    beginMatchup(index) {
      if (index >= this.matchups.length) return this.closeRound();
      this.mu = index;
      this.step = 'show';
      this.stepEndsAt = this.now() + SHOW_MS;
      this.broadcastPhase();
    }

    // A prompt as players see it: the prompt's index into PROMPTS, or "comic:N" for a comic to caption.
    promptInfo(p) {
      if (typeof p === 'string' && p.startsWith('comic:')) {
        const file = Prompts.COMICS[Number(p.slice(6))] || Prompts.COMICS[0];
        return { id: p, text: Prompts.COMIC_PROMPT, comic: `img/comics/${file}`, note: Prompts.COMIC_NOTE };
      }
      return { id: p, text: Prompts.PROMPTS[p], comic: null, note: null };
    }

    get matchup() {
      return this.matchups[this.mu] || null;
    }

    // Who can vote on the current matchup: everyone here who didn't write one of its answers.
    eligibleVoters() {
      const m = this.matchup;
      if (!m) return [];
      const authors = new Set(m.answers.map((a) => a.author));
      // In the final you vote for anyone but yourself, so you need at least one answer that isn't yours.
      return [...this.members.keys()].filter((id) => (m.final ? m.answers.some((a) => a.author !== id) : !authors.has(id)));
    }

    openVote() {
      const m = this.matchup;
      this.step = 'vote';
      this.stepEndsAt = this.now() + (m.final ? FINAL_VOTE_SECONDS : VOTE_SECONDS) * 1000;
      if (!this.eligibleVoters().length) return this.reveal(); // nobody can vote: straight to the reveal
      this.broadcastPhase();
    }

    vote(id, msg) {
      const m = this.matchup;
      if (this.phase !== 'matchup' || this.step !== 'vote' || !m) return false;
      if (msg.matchup !== undefined && msg.matchup !== this.mu) return false;
      if (!this.eligibleVoters().includes(id)) return false;
      let picks;
      if (m.final) {
        if (!Array.isArray(msg.choices)) return false;
        picks = [...new Set(msg.choices.filter((i) => Number.isInteger(i) && i >= 0 && i < m.answers.length && m.answers[i].author !== id))];
        if (!picks.length || picks.length > FINAL_PICKS) return false;
      } else {
        const i = msg.choice === 'a' ? 0 : msg.choice === 'b' ? 1 : -1;
        if (i < 0 || i >= m.answers.length) return false;
        picks = [i];
      }
      m.votes.set(id, picks);
      if (this.allVoted()) this.votesIn();
      else this.broadcastPhase();
      return true;
    }

    // Everyone's voted: the vote step ends shortly, so the last voter's badge is seen landing first.
    votesIn() {
      this.stepEndsAt = Math.min(this.stepEndsAt, this.now() + VOTES_IN_MS);
      this.broadcastPhase();
    }

    allVoted() {
      const voters = this.eligibleVoters();
      const m = this.matchup;
      return voters.length > 0 && voters.every((v) => m.votes.has(v));
    }

    // Count the votes, score them and show who wrote what.
    reveal() {
      const m = this.matchup;
      m.answers.forEach((a) => { a.voters = []; });
      m.votes.forEach((picks, voter) => picks.forEach((i) => m.answers[i].voters.push(voter)));
      const practice = !this.eligibleVoters().length && !m.votes.size;
      const scored = scoreMatchup(m.answers.map((a) => a.voters.length), this.round, { sweepable: !m.final });
      const { points, cleanSweep } = scored;
      // Practice (nobody else could vote): every answer goes off, for no points.
      const winners = practice ? m.answers.map((_, i) => i) : scored.winners;
      m.result = { points, winners, cleanSweep, practice };
      m.answers.forEach((a, i) => {
        const t = this.totals.get(a.author);
        if (t && points[i]) t.total += points[i];
      });
      m.stinger = (this.stingerCount++ % STINGERS) + 1;
      this.step = 'reveal';
      this.stepEndsAt = this.now() + (cleanSweep ? SWEEP_REVEAL_MS : REVEAL_MS);
      this.broadcastPhase();
    }

    // ---------- Between rounds ----------

    closeRound() {
      const gained = new Map();
      this.matchups.forEach((m) => m.answers.forEach((a, i) => {
        gained.set(a.author, (gained.get(a.author) || 0) + ((m.result && m.result.points[i]) || 0));
      }));
      this.roundResults = [...this.totals.values()].filter((t) => this.order.includes(t.id))
        .map((t) => ({ ...t, gained: gained.get(t.id) || 0 }))
        .sort((a, b) => b.total - a.total || a.number - b.number);
      this.phase = 'standings';
      this.mu = -1;
      this.step = null;
      this.nextReady = new Set();
      this.standingsEndsAt = this.now() + (this.round >= ROUNDS ? STANDINGS_MS : NEXT_ROUND_SECONDS * 1000);
      this.broadcastPhase();
    }

    // Players still in this game who can opt in to the next round.
    nextRoundPlayers() {
      return this.order.filter((id) => this.members.has(id));
    }

    // A player pressed "Play next round". Everyone in: start straight away.
    readyNextRound(id, round) {
      if (this.phase !== 'standings' || this.round >= ROUNDS) return false;
      if (round !== undefined && round !== this.round) return false;
      if (!this.nextRoundPlayers().includes(id) || this.nextReady.has(id)) return false;
      this.nextReady.add(id);
      if (this.nextRoundPlayers().every((p) => this.nextReady.has(p))) this.startNextRound();
      else this.broadcastPhase();
      return true;
    }

    // Whoever opted in plays on (the rest sit out and watch). Nobody: the game ends.
    startNextRound() {
      const going = this.nextRoundPlayers().filter((id) => this.nextReady.has(id));
      if (!going.length) return this.endGame();
      this.order = going;
      // The final gets its own short intro first.
      if (this.finalRound && this.round + 1 === ROUNDS && this.introLength('final') > 0) this.beginIntro('final');
      else this.beginWrite();
    }

    gameTick() {
      if (!this.started) return;
      const now = this.now();
      if (this.phase === 'intro') {
        if (now >= this.introEndsAt) this.beginWrite();
      } else if (this.phase === 'write') {
        if (now >= this.writeEndsAt + WRITE_GRACE_MS) this.beginMatchups();
      } else if (this.phase === 'matchup' && now >= this.stepEndsAt) {
        if (this.step === 'show') this.openVote();
        else if (this.step === 'vote') this.reveal();
        else this.beginMatchup(this.mu + 1);
      } else if (this.phase === 'standings' && now >= this.standingsEndsAt) {
        if (this.round >= ROUNDS) this.endGame();
        else this.startNextRound();
      }
    }

    endGame() {
      this.stopLoop();
      this.started = false;
      this.phase = 'results';
      this.fillSlots();
      this.broadcast('gameOver', { game: this.game, winnerVo: ((this.winnerVoCount = (this.winnerVoCount || 0) + 1) - 1) % WINNER_VOS + 1, ...standingsOf([...this.totals.values()]) });
      this.broadcastLobby();
    }

    stopLoop() {
      if (this.loop !== null) this.clearInterval(this.loop);
      this.loop = null;
    }

    // ---------- Payloads ----------

    serializeMember(m) {
      return { id: m.id, role: m.role, number: m.number, name: m.name, color: m.color };
    }

    memberInfo(id) {
      const m = this.members.get(id) || this.totals.get(id);
      return m ? { id, name: m.name, color: m.color, number: m.number } : { id, name: 'Gone', color: '#8a8a8a', number: null };
    }

    // The current matchup as everyone sees it: authors stay hidden until the reveal; voters show as they vote.
    serializeMatchup() {
      const m = this.matchup;
      if (!m) return null;
      const revealed = this.step === 'reveal';
      const live = new Map(m.answers.map((_, i) => [i, []]));
      m.votes.forEach((picks, voter) => picks.forEach((i) => live.get(i).push(voter)));
      return {
        index: this.mu,
        count: this.matchups.length,
        step: this.step,
        stepEndsAt: this.stepEndsAt,
        stepMs: this.step === 'show' ? SHOW_MS : this.step === 'vote' ? (m.final ? FINAL_VOTE_SECONDS : VOTE_SECONDS) * 1000 : this.stepEndsAt - this.now(),
        final: m.final,
        picks: m.final ? FINAL_PICKS : 1,
        ...(() => { const info = this.promptInfo(m.prompt); return { prompt: info.text, comic: info.comic, note: info.note }; })(),
        answers: m.answers.map((a, i) => ({
          text: a.text,
          empty: a.empty,
          voters: (revealed ? a.voters : live.get(i)).map((v) => this.memberInfo(v)),
          author: revealed ? this.memberInfo(a.author) : null,
          // Your own answer is marked for you (you can't vote for it); the client matches this to its id.
          authorId: m.final ? a.author : null,
          points: revealed ? m.result.points[i] : null,
          winner: revealed ? m.result.winners.includes(i) : null,
        })),
        authors: m.final ? null : m.answers.map((a) => a.author), // who can't vote (shown as "your matchup")
        voters: this.eligibleVoters(),
        voted: [...m.votes.keys()],
        cleanSweep: revealed ? m.result.cleanSweep : null,
        practice: revealed ? !!m.result.practice : null,
        stinger: revealed ? m.stinger : null,
      };
    }

    serializeWriters() {
      return [...this.entries].filter(([id]) => this.members.has(id)).map(([id, e]) => {
        const m = this.members.get(id);
        return { id, name: m.name, number: m.number, color: m.color, done: e.done, prompts: e.prompts.map((p) => this.promptInfo(p)) };
      });
    }

    phasePayload() {
      const p = { phase: this.phase, round: this.round, rounds: ROUNDS, now: this.now(), totals: [...this.totals.values()].map((t) => ({ ...t })) };
      if (this.phase === 'intro') Object.assign(p, { introKind: this.introKind, introStartedAt: this.introStartedAt, introEndsAt: this.introEndsAt, comicFinal: this.introKind === 'final' && this.comicFinal });
      if (this.phase === 'write') Object.assign(p, { writeEndsAt: this.writeEndsAt, writeMs: this.writeMs, final: this.isFinal, writers: this.serializeWriters() });
      if (this.phase === 'matchup') p.matchup = this.serializeMatchup();
      if (this.phase === 'standings') {
        Object.assign(p, {
          standingsEndsAt: this.standingsEndsAt, roundResults: this.roundResults.map((r) => ({ ...r })),
          nextPlayers: this.nextRoundPlayers(), nextReady: [...this.nextReady],
        });
      }
      return p;
    }

    broadcastPhase() {
      this.broadcast('phase', this.phasePayload());
    }

    lobbyPayload() {
      return {
        roomCode: this.code,
        hostId: this.hostId,
        started: this.started,
        players: this.players.map((m) => this.serializeMember(m)),
        crowd: this.crowd.map((m) => this.serializeMember(m)),
      };
    }

    gamePayload() {
      return { game: this.game, order: this.order.slice(), ...this.phasePayload(), ...this.lobbyPayload() };
    }

    broadcastLobby() {
      this.broadcast('lobbyUpdate', this.lobbyPayload());
    }
  }

  return {
    GameRoom,
    generateRoomCode,
    ringDeal,
    scoreMatchup,
    standingsOf,
    sanitizeName,
    sanitizeAnswer,
    TICK_RATE,
    MAX_PLAYERS,
    MIN_PLAYERS,
    ROUNDS,
    PROMPTS_PER_PLAYER,
    WRITE_SECONDS,
    WRITE_GRACE_MS,
    ANSWER_MAX,
    NO_ANSWER,
    SHOW_MS,
    VOTE_SECONDS,
    FINAL_VOTE_SECONDS,
    FINAL_PICKS,
    REVEAL_MS,
    WINNER_VOS,
    VOTES_IN_MS,
    SWEEP_REVEAL_MS,
    POINTS_PER_VOTE,
    CLEAN_SWEEP_BONUS,
    STINGERS,
    STANDINGS_MS,
    NEXT_ROUND_SECONDS,
    INTRO_MS,
    FINAL_INTRO_MS,
    PLAYER_COLORS,
    NAME_MAX,
  };
});
