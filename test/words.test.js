const test = require('node:test');
const assert = require('node:assert/strict');
const { PAIRS, buildBars, drawPairs, shuffledIndexes, BARS_PER_TURN, PAIRS_PER_TURN } = require('../public/js/words.js');

test('there are 60 rhyming pairs', () => {
  assert.equal(PAIRS.length, 60);
  PAIRS.forEach((pair) => {
    assert.equal(pair.length, 2);
    pair.forEach((w) => assert.ok(typeof w === 'string' && w.trim() === w && w.length > 1, `bad word ${w}`));
  });
});

test('no word or pair appears twice', () => {
  const words = PAIRS.flat().map((w) => w.toLowerCase());
  const dupes = words.filter((w, i) => words.indexOf(w) !== i);
  assert.deepEqual(dupes, []);
});

test('the classic hip-hop words are in there', () => {
  const words = new Set(PAIRS.flat());
  ['knockout', 'big time', 'hustle', 'bag', 'finesse', 'flex', 'lit', 'trill', 'no cap'].forEach((w) => assert.ok(words.has(w), w));
});

test('a turn has 16 bars from 8 pairs, changing pair every 2 bars', () => {
  const pairs = drawPairs();
  assert.equal(pairs.length, PAIRS_PER_TURN);
  assert.equal(new Set(pairs.map((p) => p.join('/'))).size, 8, 'no repeats within a turn');
  const bars = buildBars(pairs);
  assert.equal(bars.length, BARS_PER_TURN);
  bars.forEach((bar, i) => {
    assert.equal(bar.index, i);
    assert.equal(bar.couplet, Math.floor(i / 2));
    assert.equal(bar.side, i % 2 ? 'B' : 'A');
    assert.deepEqual(bar.pair, pairs[bar.couplet]);
    assert.equal(bar.word, pairs[bar.couplet][i % 2]);
  });
  for (let i = 0; i < 16; i += 2) {
    assert.deepEqual(bars[i].pair, bars[i + 1].pair, 'both bars of a couplet share a pair');
    if (i) assert.notDeepEqual(bars[i].pair, bars[i - 1].pair, 'the pair changes after 2 bars');
  }
});

test('shuffledIndexes is a permutation', () => {
  const s = shuffledIndexes(60);
  assert.deepEqual([...s].sort((a, b) => a - b), [...Array(60).keys()]);
});
