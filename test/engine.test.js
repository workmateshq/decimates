const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../public/js/engine.js');
const Prompts = require('../public/js/prompts.js');

const {
  GameRoom, generateRoomCode, ringDeal, scoreMatchup, sanitizeAnswer, sanitizeName, NAME_MAX, ANSWER_MAX, NO_ANSWER,
  WRITE_SECONDS, WRITE_GRACE_MS, SHOW_MS, VOTE_SECONDS, FINAL_VOTE_SECONDS, REVEAL_MS, SWEEP_REVEAL_MS, CLEAN_SWEEP_BONUS,
  NEXT_ROUND_SECONDS, STANDINGS_MS, INTRO_MS, ROUNDS, MAX_PLAYERS, MIN_PLAYERS, STINGERS,
} = E;

function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A room with a manual clock and loop that records every message it sends.
function makeRoom({ introMs = 0, maxPlayers, seed = 7 } = {}) {
  const sent = [];
  let tickFn = null;
  let clock = 1000;
  const room = new GameRoom('TEST', {
    broadcast: (ev, data) => sent.push({ to: '*', ev, data }),
    send: (to, ev, data) => sent.push({ to, ev, data }),
    setInterval: (fn) => { tickFn = fn; return 1; },
    clearInterval: () => { tickFn = null; },
    random: seeded(seed),
    now: () => clock,
    introMs,
    maxPlayers,
  });
  const advance = (ms) => { clock += ms; if (tickFn) tickFn(); };
  const last = (ev) => [...sent].reverse().find((m) => m.ev === ev);
  return { room, sent, last, advance, now: () => clock, isRunning: () => tickFn !== null };
}

// N players (p1..pN) plus a crowd (c1..), game started.
function startedGame(players = 3, crowd = 0, options = {}, roomOptions = {}) {
  const ctx = makeRoom({ maxPlayers: crowd ? players : undefined, ...roomOptions });
  for (let i = 1; i <= players; i++) ctx.room.join(`p${i}`, `P${i}`);
  for (let i = 1; i <= crowd; i++) ctx.room.join(`c${i}`, `C${i}`);
  assert.ok(ctx.room.start('p1', options));
  return ctx;
}

// Everyone answers each of their prompts and locks in.
function writeAll(ctx, text = (id, p) => `${id} on ${p}`) {
  const { room } = ctx;
  [...room.entries.keys()].forEach((id) => {
    room.entries.get(id).prompts.forEach((p) => room.input(id, { type: 'answer', promptId: p, text: text(id, p) }));
  });
  [...room.entries.keys()].forEach((id) => room.input(id, { type: 'done' }));
}
const toVote = (ctx) => ctx.advance(ctx.room.stepEndsAt - ctx.now());
const authorIdx = (ctx, id) => ctx.room.matchup.answers.findIndex((a) => a.author === id);

test('room codes are 4 letters without I or O', () => {
  for (let i = 0; i < 50; i++) assert.match(generateRoomCode(), /^[A-HJ-NP-Z]{4}$/);
});

test('names and answers are trimmed, without control characters, and limited', () => {
  assert.equal(sanitizeName('  Zak \n the   Joker  '), 'Zak the Joker');
  assert.equal(Array.from(sanitizeName('x'.repeat(40))).length, NAME_MAX);
  assert.equal(sanitizeAnswer('  a\tbig\u0000 joke '), 'a big joke');
  assert.equal(sanitizeAnswer('y'.repeat(300)).length, ANSWER_MAX);
  assert.equal(sanitizeAnswer({ evil: 1 }), '');
});

test('the prompts: 200+ unique, plus 50 unique stock jokes', () => {
  assert.ok(Prompts.PROMPTS.length >= 200, `${Prompts.PROMPTS.length} prompts`);
  assert.equal(new Set(Prompts.PROMPTS.map((p) => p.toLowerCase())).size, Prompts.PROMPTS.length);
  assert.equal(Prompts.STOCK_JOKES.length, 50);
  assert.equal(new Set(Prompts.STOCK_JOKES).size, 50);
  assert.ok(Prompts.STOCK_JOKES.every((j) => j.length <= ANSWER_MAX));
});

test('the ring deal: every prompt to exactly 2 players, every player exactly 2 prompts', () => {
  for (let n = 2; n <= MAX_PLAYERS; n++) {
    const ids = Array.from({ length: n }, (_, i) => `p${i}`);
    const deal = ringDeal(ids);
    const perPrompt = new Map();
    ids.forEach((id) => {
      assert.equal(new Set(deal[id]).size, 2, `${id} gets 2 different prompts with ${n} players`);
      deal[id].forEach((k) => perPrompt.set(k, (perPrompt.get(k) || 0) + 1));
    });
    assert.equal(perPrompt.size, n);
    perPrompt.forEach((count) => assert.equal(count, 2));
  }
});

test('alone: 2 prompts of your own, and every matchup is a practice reveal (no votes, no points)', () => {
  assert.deepEqual(ringDeal(['solo']), { solo: [0, 1] });
  const ctx = startedGame(1);
  const { room } = ctx;
  assert.equal(room.entries.get('p1').prompts.length, 2);
  assert.equal(new Set(room.entries.get('p1').prompts).size, 2);
  writeAll(ctx);
  assert.equal(room.matchups.length, 2);
  ctx.advance(room.stepEndsAt - ctx.now());
  assert.equal(room.step, 'reveal', 'nobody to vote: straight to the reveal');
  const m = room.phasePayload().matchup;
  assert.equal(m.practice, true);
  assert.ok(m.answers.every((a) => a.winner && a.points === 0));
  assert.equal(room.totals.get('p1').total, 0);
});

test('players and the crowd: the first 8 play, later arrivals (and anyone mid-game) join the crowd', () => {
  const { room } = makeRoom();
  for (let i = 1; i <= 10; i++) room.join(`m${i}`, 'Joker');
  assert.equal(room.players.length, MAX_PLAYERS);
  assert.equal(room.crowd.length, 2);
  assert.equal(new Set([...room.members.values()].map((m) => m.name)).size, 10, 'names made unique');
  const ctx = startedGame(3);
  ctx.room.join('late', 'Late');
  assert.equal(ctx.room.members.get('late').role, 'crowd');
});

test('a game can start with 1 player, like Rapmates (minPlayers raises it for testing)', () => {
  const { room } = makeRoom();
  room.join('a');
  assert.equal(room.start('a', { minPlayers: 2 }), false);
  assert.ok(room.start('a'));
  assert.equal(MIN_PLAYERS, 1);
});

test('a game opens with the intro; the host can skip it', () => {
  const ctx = makeRoom({ introMs: null });
  ['a', 'b', 'c'].forEach((id) => ctx.room.join(id));
  ctx.room.start('a');
  assert.equal(ctx.room.phase, 'intro');
  assert.equal(ctx.last('gameStarted').data.introEndsAt - ctx.now(), INTRO_MS);
  assert.equal(ctx.room.input('b', { type: 'skipIntro' }), false, 'only the host');
  assert.ok(ctx.room.input('a', { type: 'skipIntro' }));
  assert.equal(ctx.room.phase, 'write');
  const ctx2 = makeRoom({ introMs: null });
  ['a', 'b', 'c'].forEach((id) => ctx2.room.join(id));
  ctx2.room.start('a');
  ctx2.advance(INTRO_MS);
  assert.equal(ctx2.room.phase, 'write', 'or it ends on its own');
});

test('writing: 90 seconds on the host clock, 2 prompts each, answers private until the matchups', () => {
  const ctx = startedGame(4);
  const p = ctx.last('gameStarted').data;
  assert.equal(p.phase, 'write');
  assert.equal(p.writeEndsAt - ctx.now(), WRITE_SECONDS * 1000);
  assert.equal(p.writers.length, 4);
  assert.ok(p.writers.every((w) => w.prompts.length === 2 && w.prompts.every((q) => typeof q.text === 'string')));
  assert.ok(ctx.room.input('p1', { type: 'answer', promptId: p.writers[0].prompts[0].id, text: 'SECRET-JOKE' }));
  ctx.room.input('p1', { type: 'done' });
  assert.ok(!JSON.stringify(ctx.last('phase').data).includes('SECRET-JOKE'), 'answers stay private while writing');
  assert.equal(ctx.room.input('p1', { type: 'answer', promptId: 99999, text: 'not mine' }), false);
  ctx.advance(WRITE_SECONDS * 1000);
  assert.equal(ctx.room.phase, 'write', 'a short grace for the last drafts');
  ctx.advance(WRITE_GRACE_MS);
  assert.equal(ctx.room.phase, 'matchup');
  assert.equal(ctx.room.matchups.length, 4, 'one matchup per prompt');
  const empties = ctx.room.matchups.flatMap((m) => m.answers).filter((a) => a.empty);
  assert.ok(empties.length === 7 && empties.every((a) => a.text === NO_ANSWER), 'empty answers become "(no answer)"');
});

test('done, edit and done again; everyone locked in starts the matchups straight away', () => {
  const ctx = startedGame(3);
  const { room } = ctx;
  room.input('p1', { type: 'done' });
  assert.ok(room.input('p1', { type: 'edit' }));
  room.input('p2', { type: 'done' });
  room.input('p3', { type: 'done' });
  assert.equal(room.phase, 'write', 'p1 is editing');
  room.input('p1', { type: 'done' });
  assert.equal(room.phase, 'matchup');
  assert.equal(room.step, 'show');
});

test('a matchup: show, then vote (authors can\'t), then reveal with points; voters show as they vote', () => {
  const ctx = startedGame(3, 1);
  const { room } = ctx;
  writeAll(ctx);
  const m = room.matchup;
  const authors = m.answers.map((a) => a.author);
  const others = ['p1', 'p2', 'p3', 'c1'].filter((id) => !authors.includes(id));
  assert.equal(others.length, 2, 'the other player and the crowd');
  const show = ctx.last('phase').data.matchup;
  assert.equal(show.step, 'show');
  assert.ok(show.answers.every((a) => a.author === null), 'anonymous');
  toVote(ctx);
  assert.equal(room.step, 'vote');
  assert.equal(room.stepEndsAt - ctx.now(), VOTE_SECONDS * 1000);
  assert.equal(room.input(authors[0], { type: 'vote', matchup: 0, choice: 'a' }), false, 'authors can\'t vote');
  assert.ok(room.input(others[0], { type: 'vote', matchup: 0, choice: 'a' }));
  const live = ctx.last('phase').data.matchup;
  assert.deepEqual(live.answers[0].voters.map((v) => v.id), [others[0]], 'voter avatars appear on the answer');
  assert.equal(live.answers[0].author, null);
  room.input(others[1], { type: 'vote', matchup: 0, choice: 'b' });
  assert.equal(room.step, 'reveal', 'everyone voted: reveal early');
  const r = ctx.last('phase').data.matchup;
  assert.deepEqual(r.answers.map((a) => a.author.id), authors);
  assert.deepEqual(r.answers.map((a) => a.points), [100, 100], 'round 1: 100 per vote');
  assert.deepEqual(r.answers.map((a) => a.winner), [true, true], 'a tie: both explode');
  assert.equal(r.cleanSweep, false);
  assert.ok(r.stinger >= 1 && r.stinger <= STINGERS);
  assert.equal(room.stepEndsAt - ctx.now(), REVEAL_MS);
  ctx.advance(REVEAL_MS);
  assert.equal(room.mu, 1, 'next matchup');
  assert.equal(room.step, 'show');
});

test('scoring: votes x 100 x round; a clean sweep earns the bonus; nobody votes, nobody scores', () => {
  assert.deepEqual(scoreMatchup([3, 0], 1), { points: [300 + CLEAN_SWEEP_BONUS, 0], winners: [0], cleanSweep: true });
  assert.deepEqual(scoreMatchup([2, 1], 2), { points: [400, 200], winners: [0], cleanSweep: false });
  assert.deepEqual(scoreMatchup([1, 1], 1), { points: [100, 100], winners: [0, 1], cleanSweep: false });
  assert.deepEqual(scoreMatchup([0, 0], 1), { points: [0, 0], winners: [], cleanSweep: false });
  assert.deepEqual(scoreMatchup([2, 0, 0], 3, { sweepable: false }), { points: [600, 0, 0], winners: [0], cleanSweep: false });

  const ctx = startedGame(3, 1);
  const { room } = ctx;
  writeAll(ctx);
  toVote(ctx);
  const authors = room.matchup.answers.map((a) => a.author);
  const voters = room.eligibleVoters();
  voters.forEach((v) => room.input(v, { type: 'vote', matchup: 0, choice: 'b' }));
  assert.equal(room.matchup.result.cleanSweep, true);
  assert.equal(room.totals.get(authors[1]).total, 200 + CLEAN_SWEEP_BONUS);
  assert.equal(room.stepEndsAt - ctx.now(), SWEEP_REVEAL_MS, 'a longer reveal for the clean sweep');
});

test('nobody votes in time: nobody scores, on to the next matchup', () => {
  const ctx = startedGame(3);
  writeAll(ctx);
  toVote(ctx);
  ctx.advance(VOTE_SECONDS * 1000);
  assert.equal(ctx.room.step, 'reveal');
  assert.deepEqual(ctx.room.matchup.result.points, [0, 0]);
});

test('a full round: every matchup, then the scoreboard waits up to 30 s for "Play next round"', () => {
  const ctx = startedGame(3);
  const { room } = ctx;
  writeAll(ctx);
  for (let i = 0; i < 3; i++) {
    assert.equal(room.mu, i);
    toVote(ctx);
    room.eligibleVoters().forEach((v) => room.input(v, { type: 'vote', matchup: i, choice: 'a' }));
    ctx.advance(room.stepEndsAt - ctx.now());
  }
  assert.equal(room.phase, 'standings');
  const p = ctx.last('phase').data;
  assert.equal(p.standingsEndsAt - ctx.now(), NEXT_ROUND_SECONDS * 1000);
  assert.equal(p.roundResults.length, 3);
  assert.ok(room.input('p1', { type: 'nextRound', round: 1 }));
  assert.equal(room.input('p1', { type: 'nextRound', round: 1 }), false, 'once');
  room.input('p2', { type: 'nextRound', round: 1 });
  room.input('p3', { type: 'nextRound', round: 1 });
  assert.equal(room.phase, 'write');
  assert.equal(room.round, 2);
});

test('prompts never repeat across the game', () => {
  const ctx = startedGame(8);
  const { room } = ctx;
  const seen = [];
  for (let r = 1; r <= 2; r++) {
    room.entries.forEach((e) => seen.push(...e.prompts));
    writeAll(ctx);
    while (room.phase === 'matchup') ctx.advance(room.stepEndsAt - ctx.now());
    room.nextRoundPlayers().forEach((id) => room.input(id, { type: 'nextRound', round: r }));
  }
  room.entries.forEach((e) => seen.push(...e.prompts));
  assert.equal(new Set(seen).size, 8 + 8 + 1);
});

test('between rounds: only those who opt in play on; nobody opting in ends the game', () => {
  const ctx = startedGame(4);
  const { room } = ctx;
  writeAll(ctx);
  while (room.phase === 'matchup') ctx.advance(room.stepEndsAt - ctx.now());
  room.input('p1', { type: 'nextRound', round: 1 });
  room.input('p3', { type: 'nextRound', round: 1 });
  room.input('p4', { type: 'nextRound', round: 1 });
  ctx.advance(NEXT_ROUND_SECONDS * 1000);
  assert.deepEqual([...room.entries.keys()], ['p1', 'p3', 'p4'], 'p2 sits out');
  writeAll(ctx);
  while (room.phase === 'matchup') ctx.advance(room.stepEndsAt - ctx.now());
  ctx.advance(NEXT_ROUND_SECONDS * 1000);
  assert.equal(room.phase, 'results', 'nobody opted in: the podium');
});

test('the final (round 3): everyone answers the same prompt and votes for up to 3 (not their own), x3 points', () => {
  const ctx = startedGame(4, 1);
  const { room } = ctx;
  for (let r = 1; r <= 2; r++) {
    writeAll(ctx);
    while (room.phase === 'matchup') ctx.advance(room.stepEndsAt - ctx.now());
    room.nextRoundPlayers().forEach((id) => room.input(id, { type: 'nextRound', round: r }));
  }
  assert.equal(room.round, ROUNDS);
  const prompts = new Set([...room.entries.values()].map((e) => e.prompts.join()));
  assert.equal(prompts.size, 1, 'one shared prompt');
  assert.equal(ctx.last('phase').data.final, true);
  writeAll(ctx);
  assert.equal(room.matchups.length, 1);
  assert.equal(room.matchup.answers.length, 4);
  toVote(ctx);
  assert.equal(room.stepEndsAt - ctx.now(), FINAL_VOTE_SECONDS * 1000);
  const own = authorIdx(ctx, 'p1');
  assert.equal(room.input('p1', { type: 'vote', matchup: 0, choices: [own] }), false, 'not your own');
  assert.equal(room.input('p1', { type: 'vote', matchup: 0, choices: [0, 1, 2, 3].filter((i) => i !== own) }), true, '3 picks');
  assert.equal(room.input('c1', { type: 'vote', matchup: 0, choices: [0, 1, 2, 3] }), false, 'at most 3');
  const p2 = authorIdx(ctx, 'p2');
  ['c1', 'p3', 'p4'].forEach((v) => room.input(v, { type: 'vote', matchup: 0, choices: [p2] }));
  const before = room.totals.get('p2').total;
  room.input('p2', { type: 'vote', matchup: 0, choices: [authorIdx(ctx, 'p3')] });
  assert.equal(room.step, 'reveal');
  assert.equal(room.totals.get('p2').total - before, 4 * 100 * 3, '4 votes x 100 x round 3');
  assert.equal(room.matchup.result.cleanSweep, false, 'no clean sweep in the final');
  ctx.advance(room.stepEndsAt - ctx.now());
  assert.equal(room.phase, 'standings');
  ctx.advance(STANDINGS_MS);
  assert.equal(room.phase, 'results');
  const over = ctx.last('gameOver').data;
  assert.equal(over.standings[0].id, 'p2');
  assert.deepEqual(over.winnerIds, ['p2']);
});

test('leavers: mid-write their answers become "(no answer)"; an author leaving mid-matchup doesn\'t stall it', () => {
  const ctx = startedGame(4);
  const { room } = ctx;
  ['p1', 'p2', 'p3'].forEach((id) => {
    room.entries.get(id).prompts.forEach((p) => room.input(id, { type: 'answer', promptId: p, text: 'joke' }));
    room.input(id, { type: 'done' });
  });
  assert.equal(room.phase, 'write');
  room.leave('p4');
  assert.equal(room.phase, 'matchup', 'the rest were done');
  const gone = room.matchups.flatMap((m) => m.answers).filter((a) => a.author === 'p4');
  assert.ok(gone.length === 2 && gone.every((a) => a.text === NO_ANSWER));
  toVote(ctx);
  const voters = room.eligibleVoters();
  room.input(voters[0], { type: 'vote', matchup: 0, choice: 'a' });
  const author = room.matchup.answers[0].author;
  const notVoted = voters.filter((v) => !room.matchup.votes.has(v));
  notVoted.forEach((v) => room.leave(v));
  assert.equal(room.step, 'reveal', 'the last voter left: reveal');
  assert.ok(room.members.has(author) || author === 'p4');
});

test('the stinger after each matchup cycles, so everyone hears the same one', () => {
  const ctx = startedGame(3);
  const { room } = ctx;
  writeAll(ctx);
  const seen = [];
  while (room.phase === 'matchup') {
    if (room.step === 'reveal') seen.push(room.matchup.stinger);
    ctx.advance(room.stepEndsAt - ctx.now());
  }
  assert.deepEqual(seen, [1, 2, 3]);
});

test('the comic final: about 1 game in 3, everyone captions the same Buck Ryan strip', () => {
  const playToFinal = (options, seed) => {
    const ctx = startedGame(3, 0, options, { seed });
    for (let r = 1; r <= 2; r++) {
      writeAll(ctx);
      while (ctx.room.phase === 'matchup') ctx.advance(ctx.room.stepEndsAt - ctx.now());
      ctx.room.nextRoundPlayers().forEach((id) => ctx.room.input(id, { type: 'nextRound', round: r }));
    }
    return ctx;
  };
  const ctx = playToFinal({ comicFinal: true });
  const w = ctx.last('phase').data.writers;
  assert.ok(w.every((x) => x.prompts.length === 1 && x.prompts[0].id === w[0].prompts[0].id), 'the same comic for everyone');
  const prompt = w[0].prompts[0];
  assert.equal(prompt.text, Prompts.COMIC_PROMPT);
  assert.match(prompt.comic, /^img\/comics\/buck-ryan-0\d\.jpg$/);
  assert.equal(prompt.note, 'FYI the Buck Ryan comic strip ran in the Daily Mirror from 22 March 1937 to July 1962.');
  assert.ok(ctx.room.input('p1', { type: 'answer', promptId: prompt.id, text: 'Not the face!' }));
  writeAll(ctx);
  assert.equal(ctx.last('phase').data.matchup.comic, prompt.comic);
  const normal = playToFinal({ comicFinal: false });
  assert.equal(normal.last('phase').data.writers[0].prompts[0].comic, null);
  let comics = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const c = makeRoom({ seed });
    ['a', 'b', 'c'].forEach((id) => c.room.join(id));
    c.room.start('a');
    if (c.room.comicFinal) comics++;
  }
  assert.ok(comics > 70 && comics < 130, `${comics} of 300 games`);
});

test('the announcer: one stinger line per stinger; once recorded, every line has its bm_daniel MP3', () => {
  assert.equal(Prompts.STINGER_LINES.length, STINGERS);
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/voice.js'), 'utf8'), sandbox);
  const voice = sandbox.window.DECIMATES_VOICE;
  if (!Object.keys(voice).length) return; // not recorded yet (node scripts/make-voice.mjs)
  [...Prompts.PROMPTS, Prompts.COMIC_PROMPT, ...Prompts.STINGER_LINES].forEach((line) => {
    assert.ok(voice[line], `no recording for "${line}" (run node scripts/make-voice.mjs)`);
    assert.ok(fs.existsSync(path.join(__dirname, '../public', voice[line])), `missing file ${voice[line]}`);
  });
});
