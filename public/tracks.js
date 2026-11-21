// Rapmates backing tracks (MP3s in public/tracks/). Runs in the browser (window.RapmatesTracks) and in
// Node for tests (require).
//
// Every turn plays one track once, from `offset + skipBars` bars into the file:
//   bars 1-4   intro: "Get ready" for bars 1-3, a 4-3-2-1 count-in on bar 4
//   bars 5-20  the 16 rap bars (the drums are in)
//   then the tail plays on under the vote, fading out over FADE_SEC from `fadeAfterBars`.
// Bar n starts at startTime + (n - 1) * 4 * 60 / bpm, where startTime is when the file position
// offset + skipBars * barSeconds plays.
//
// Config per track:
//   src            file path
//   bpm            tempo
//   offset         seconds from the start of the decoded file to beat 1 of the file's bar 1
//   skipBars       bars of the file to skip before the 4-bar intro (for files with a longer intro)
//   introBars      bars before the rapping starts (4)
//   rapBars        bars of rapping (16)
//   fadeAfterBars  bars after the playback start at which to fade the track out
//
// To add a track, cut it to: a 4-bar intro, drums in on bar 5 for 16 bars, then a short tail. Measure
// `offset` (see README) and add an entry. Files with a longer intro can use skipBars; files whose drums
// carry on past bar 20 can use fadeAfterBars: 20.
//
// Offsets were measured from the browser's own decodeAudioData output (48 kHz, so MP3 encoder delay is
// handled exactly as players hear it): a high-passed energy onset function in 1 ms hops, fitted to the
// beat grid at the known tempo over each drum section (the median hit sits within 1 ms of the grid).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RapmatesTracks = factory();
})(typeof self !== 'undefined' ? self : this, () => {
  const FADE_SEC = 1.5;

  const TRACKS = [
    // Drums in at bar 5, out after bar 20, then a ~7 s decaying tail: let ~1 bar of it ring.
    // Measured: 59 hits, median within 0.5 ms of the grid.
    { id: 'brooklyn', name: 'Brooklyn Boom Bap', src: 'tracks/90BPM-Brooklyn-Boom-Bap.mp3', bpm: 90, offset: 0.086, skipBars: 0, introBars: 4, rapBars: 16, fadeAfterBars: 21 },
    // Drums in at bar 5, out after bar 20, short tail. Measured: 58 hits, median within 1 ms.
    { id: 'harlem', name: 'Harlem Boom Bap', src: 'tracks/90BPM-Harlem-Boom-Bap.mp3', bpm: 90, offset: 0.067, skipBars: 0, introBars: 4, rapBars: 16, fadeAfterBars: 21 },
    // Drums in at bar 5, out after bar 20, short tail. Measured: 60 hits, median within 0.5 ms.
    { id: 'detroit', name: 'Detroit Horrorcore', src: 'tracks/90BPM-Detroit-Horrorcore.mp3', bpm: 90, offset: 0.066, skipBars: 0, introBars: 4, rapBars: 16, fadeAfterBars: 21 },
    // Drums in at bar 5, the music stops after bar 20. Measured: 47 hits, median within 1 ms.
    { id: 'longbeach', name: 'Long Beach G-Funk', src: 'tracks/90BPM-Long-Beach-G-Funk.mp3', bpm: 90, offset: 0.087, skipBars: 0, introBars: 4, rapBars: 16, fadeAfterBars: 21 },
  ];

  const byId = (id) => TRACKS.find((t) => t.id === id) || null;
  const barSeconds = (track) => (4 * 60) / track.bpm;
  // Where in the file playback starts (beat 1 of intro bar 1).
  const playbackOffset = (track) => track.offset + track.skipBars * barSeconds(track);
  // Seconds from intro bar 1 to the end of the last rap bar.
  const turnSeconds = (track) => (track.introBars + track.rapBars) * barSeconds(track);
  // Seconds after the playback start when the bar `n` (1-based) begins.
  const barTime = (track, n) => (n - 1) * barSeconds(track);
  const fadeAt = (track) => track.fadeAfterBars * barSeconds(track);

  // A random track, never the one just played (when there's a choice).
  function pickTrack(previousId, random = Math.random) {
    const choices = TRACKS.filter((t) => t.id !== previousId);
    const pool = choices.length ? choices : TRACKS;
    return pool[Math.floor(random() * pool.length)];
  }

  return { TRACKS, FADE_SEC, byId, barSeconds, playbackOffset, turnSeconds, barTime, fadeAt, pickTrack };
});
