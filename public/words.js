// Rhyme prompts for Rapmates. Bars come in couplets: the first bar of a couplet ends on word A, the
// second on word B. Runs in the browser (window.RapmatesWords) and in Node for tests (require).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RapmatesWords = factory();
})(typeof self !== 'undefined' ? self : this, () => {
  const BARS_PER_TURN = 16;
  const BEATS_PER_BAR = 4;
  const PAIRS_PER_TURN = BARS_PER_TURN / 2;

  // 60 family-friendly rhyming pairs [A, B]. Every word is used once across the whole list.
  const PAIRS = [
    ['knockout', 'lockout'],
    ['big time', 'prime time'],
    ['hustle', 'muscle'],
    ['bag', 'swag'],
    ['finesse', 'success'],
    ['flex', 'next'],
    ['lit', 'hit'],
    ['trill', 'skill'],
    ['no cap', 'thunderclap'],
    ['cramp', 'champ'],
    ['mic', 'strike'],
    ['flow', 'show'],
    ['crown', 'downtown'],
    ['rhyme', 'climb'],
    ['beat', 'heat'],
    ['grind', 'mind'],
    ['fresh', 'mesh'],
    ['drip', 'ship'],
    ['gold', 'bold'],
    ['boss', 'sauce'],
    ['squad', 'nod'],
    ['hype', 'stripe'],
    ['vibe', 'tribe'],
    ['stack', 'track'],
    ['cash', 'flash'],
    ['game', 'fame'],
    ['street', 'sweet'],
    ['block', 'clock'],
    ['crew', 'brand new'],
    ['bounce', 'announce'],
    ['real', 'deal'],
    ['shine', 'line'],
    ['player', 'mayor'],
    ['rocket', 'pocket'],
    ['wave', 'brave'],
    ['king', 'bling'],
    ['slick', 'quick'],
    ['mixtape', 'escape'],
    ['spotlight', 'all night'],
    ['bars', 'stars'],
    ['smooth', 'groove'],
    ['fire', 'higher'],
    ['sneakers', 'speakers'],
    ['gravy', 'wavy'],
    ['headline', 'deadline'],
    ['kicks', 'tricks'],
    ['ice', 'price'],
    ['clutch', 'touch'],
    ['rumble', 'humble'],
    ['loud', 'crowd'],
    ['boom', 'room'],
    ['zone', 'throne'],
    ['hip hop', 'non-stop'],
    ['flame', 'name'],
    ['bass', 'space'],
    ['rap', 'snap'],
    ['smash', 'splash'],
    ['vision', 'mission'],
    ['dream', 'team'],
    ['GOAT', 'boat'],
  ];

  // Fisher-Yates shuffle of 0..n-1 with an injectable random source (tests use a seeded one).
  function shuffledIndexes(n, random = Math.random) {
    const out = [...Array(n).keys()];
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  // `count` different pairs at random.
  function drawPairs(count = PAIRS_PER_TURN, random = Math.random) {
    return shuffledIndexes(PAIRS.length, random).slice(0, count).map((i) => PAIRS[i].slice());
  }

  // A turn's 16 bars from its 8 pairs: bars 0 and 1 use pair 0 (A then B), bars 2 and 3 pair 1...
  // `couplet` picks the row colour (even couplets green, odd red).
  function buildBars(pairs) {
    const bars = [];
    for (let i = 0; i < BARS_PER_TURN; i++) {
      const couplet = Math.floor(i / 2);
      const pair = pairs[couplet % pairs.length];
      const side = i % 2 === 0 ? 'A' : 'B';
      bars.push({ index: i, couplet, side, word: side === 'A' ? pair[0] : pair[1], pair: pair.slice() });
    }
    return bars;
  }

  return { PAIRS, BARS_PER_TURN, BEATS_PER_BAR, PAIRS_PER_TURN, shuffledIndexes, drawPairs, buildBars };
});
