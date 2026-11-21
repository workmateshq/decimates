// Rapmates backing tracks (MP3s in public/tracks/). Runs in the browser (window.RapmatesTracks) and in
// Node for tests (require).
//
// Every turn plays one track once, from `offset + skipBars` bars into the file:
//   bars 1-4   intro: "Get ready" for bars 1-2, an 8-beat countdown over bars 3-4
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
  const FADE_SEC = 3;

  const TRACKS = [
    // Drums in at bar 5, out after bar 20, then a ~7 s decaying tail: let ~2 bars of it ring.
    // Measured: 59 hits, median within 0.5 ms of the grid.
    { id: 'brooklyn', name: 'Brooklyn Old School', src: 'tracks/90BPM-Brooklyn-Old-School.mp3', bpm: 90, offset: 0.086, skipBars: 0, introBars: 4, rapBars: 16, fadeAfterBars: 22 },
    // Drums in at bar 5, out after bar 20, short tail. Measured: 58 hits, median within 1 ms.
    { id: 'harlem', name: 'Harlem Boom Bap', src: 'tracks/90BPM-Harlem-Boom-Bap.mp3', bpm: 90, offset: 0.067, skipBars: 0, introBars: 4, rapBars: 16, fadeAfterBars: 22 },
    // Drums in at bar 5, out after bar 20, short tail. Measured: 60 hits, median within 0.5 ms.
    { id: 'detroit', name: 'Detroit Horrorcore', src: 'tracks/90BPM-Detroit-Horrorcore.mp3', bpm: 90, offset: 0.066, skipBars: 0, introBars: 4, rapBars: 16, fadeAfterBars: 22 },
    // Re-cut (simplified). Drums in at bar 5, the music stops after bar 20. First sound and kick grid at 0.103 s.
    { id: 'longbeach', name: 'Long Beach G-Funk', src: 'tracks/90BPM-Long-Beach-G-Funk.mp3', bpm: 90, offset: 0.103, skipBars: 0, introBars: 4, rapBars: 16, fadeAfterBars: 22 },
    // Drums in at bar 5, out after bar 20. Grid fit over the drums: exactly 90 BPM, beat 1 at 0.066 s.
    { id: 'bronx', name: 'The Bronx Jazz Hop', src: 'tracks/90BPM-The-Bronx-Jazz-Hop.mp3', bpm: 90, offset: 0.066, skipBars: 0, introBars: 4, rapBars: 16, fadeAfterBars: 22 },
    // Measures 145 BPM (not 140): light drums in at bar 5, the full kick pattern from bar 7, music
    // stops after bar 20. Beat 1 at 0.081 s.
    { id: 'chicago', name: 'Chicago Drill', src: 'tracks/145BPM-Chicago-Drill.mp3', bpm: 145, offset: 0.081, skipBars: 0, introBars: 4, rapBars: 16, fadeAfterBars: 22 },
    // Measures 145 BPM (not 140). Beat 1 at 0.273 s; a 6-bar intro, drums from bar 7 for 18 bars. Skip
    // 2 intro bars so the drop lands on rap bar 1, and fade as the 16 rap bars end (the drums run on 2 bars).
    { id: 'london', name: 'London Grime', src: 'tracks/145BPM-London-Grime.mp3', bpm: 145, offset: 0.273, skipBars: 2, introBars: 4, rapBars: 16, fadeAfterBars: 20 },
  ];

  const byId = (id) => TRACKS.find((t) => t.id === id) || null;
  const barSeconds = (track) => (4 * 60) / track.bpm;
  // Where in the file playback starts (beat 1 of intro bar 1).
  const playbackOffset = (track) => track.offset + track.skipBars * barSeconds(track);
  // Seconds from intro bar 1 to the end of the last rap bar. A mode with shorter turns passes its own
  // rapBars (Write Bars: 8).
  const turnSeconds = (track, rapBars = track.rapBars) => (track.introBars + rapBars) * barSeconds(track);
  // Seconds after the playback start when the bar `n` (1-based) begins.
  const barTime = (track, n) => (n - 1) * barSeconds(track);
  // When the fade starts; a mode with shorter turns passes its own fadeAfterBars (Write Bars: 4 + 8).
  const fadeAt = (track, fadeAfterBars = track.fadeAfterBars) => fadeAfterBars * barSeconds(track);

  // A random track, never the one just played (when there's a choice). `filter` narrows the catalogue
  // (Write Bars only uses the 90 BPM tracks).
  function pickTrack(previousId, random = Math.random, filter = () => true) {
    const allowed = TRACKS.filter(filter);
    const all = allowed.length ? allowed : TRACKS;
    const choices = all.filter((t) => t.id !== previousId);
    const pool = choices.length ? choices : all;
    return pool[Math.floor(random() * pool.length)];
  }

  return { TRACKS, FADE_SEC, byId, barSeconds, playbackOffset, turnSeconds, barTime, fadeAt, pickTrack };
});
