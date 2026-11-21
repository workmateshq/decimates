const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Tracks = require('../public/tracks.js');

test('the catalogue matches the backing tracks (<bpm>BPM-*.mp3) in public/tracks/', () => {
  const files = fs.readdirSync(path.join(__dirname, '..', 'public', 'tracks')).filter((f) => /^\d+BPM-.+\.mp3$/.test(f)).sort();
  assert.deepEqual(Tracks.TRACKS.map((t) => t.src.replace('tracks/', '')).sort(), files, 'every file has an entry and vice versa');
  assert.equal(new Set(Tracks.TRACKS.map((t) => t.id)).size, Tracks.TRACKS.length);
  Tracks.TRACKS.forEach((t) => {
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'public', t.src)), t.src);
    assert.ok(t.src.startsWith(`tracks/${t.bpm}BPM-`), 'the file name starts with its tempo');
    assert.ok(t.offset > 0 && t.offset < Tracks.barSeconds(t), 'offset is within the first bar');
    assert.equal(t.introBars, 4);
    assert.equal(t.rapBars, 16);
    assert.ok(t.fadeAfterBars >= t.introBars + t.rapBars, 'no fading before the last rap bar ends');
  });
});

test('schedule maths: 4 intro bars then 16 rap bars on the track grid', () => {
  const t = Tracks.byId('brooklyn');
  assert.equal(Tracks.barSeconds(t), 8 / 3);
  assert.equal(Tracks.barTime(t, 1), 0);
  assert.equal(Tracks.barTime(t, 5), 4 * (8 / 3), 'rapping starts at bar 5');
  assert.equal(Tracks.turnSeconds(t), 20 * (8 / 3), '4 intro + 16 rap bars');
  assert.equal(Tracks.playbackOffset(t), t.offset);
  assert.equal(Tracks.fadeAt(t), 21 * (8 / 3));
});

test('skipBars starts playback later in the file (for re-cut tracks with a longer intro)', () => {
  const t = { bpm: 120, offset: 0.109, skipBars: 4, introBars: 4, rapBars: 16, fadeAfterBars: 20 };
  assert.equal(Tracks.playbackOffset(t), 0.109 + 4 * 2);
  assert.equal(Tracks.turnSeconds(t), 40);
  assert.equal(Tracks.fadeAt(t), 40);
});

test('picking a track never repeats the previous one', () => {
  for (let i = 0; i < 50; i++) {
    const prev = Tracks.TRACKS[i % Tracks.TRACKS.length].id;
    assert.notEqual(Tracks.pickTrack(prev).id, prev);
  }
  assert.ok(Tracks.byId(Tracks.pickTrack(null).id));
  // With only two tracks it alternates.
  const two = Tracks.TRACKS.slice(0, 2);
  const saved = Tracks.TRACKS.splice(2);
  try {
    assert.equal(Tracks.pickTrack(two[0].id).id, two[1].id);
    assert.equal(Tracks.pickTrack(two[1].id).id, two[0].id);
  } finally {
    Tracks.TRACKS.push(...saved);
  }
});
