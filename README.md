# Rapmates

A party rap battle for up to 4 mates, plus a crowd. Everyone's in the same room (or on a call) and the game drops the beat. Two modes:

- **Write Bars** (the default): everyone gets their own two rhyming pairs and 60 seconds to write 4 lines, then each rapper performs them over the beat (read out live, or by a robot voice), the room rates every performance, and after 3 rounds the most stars takes the mic.
- **Freestyle**: a bouncing ball keeps time and rhyme prompts tell you which word to land on the 4th beat of every bar. Spit 16 bars each, the room rates you out of 5 stars, and the best average takes the mic.

Play it at **https://workmateshq.github.io/rapmates/** or jump straight into the shared room at **https://workmateshq.github.io/rapmates/mate**.

- **Rappers and the crowd**: the first 4 people in a room get the P1–P4 slots; everyone after that joins the **crowd** (shown as "Crowd: N" in the lobby). Everybody gets a real rapper's name (half men, half women, unique in the room). Between games, a free slot goes to whoever's waited longest in the crowd.
- **No mics needed**: nobody's audio is sent anywhere. Every screen plays the same beat and shows the same bars at the same moment; you rap out loud.
- **Modes**: the host picks **Write Bars** or **Freestyle** in the lobby (everyone else sees the choice). Write Bars is the default, including in link rooms like /mate.

### Write Bars

- **Writing** (all rappers at once, 60 seconds on the host's clock): each rapper gets **their own 2 rhyming pairs** (nobody shares a pair in a round, and no pair comes back in the same game). The 4 words show as tiles at the top (each pair in its own colour). They're just prompts: write 4 lines, one per box, and use the words anywhere, in any line, or not at all. Lines are up to 80 characters; empty lines are allowed (shown as "…"). Pick **who spits it**: "I'll rap it myself" or "Robot voice (TTS)" (the default). Press **Done** to lock in early; when everyone has, the battle starts straight away. With 10 seconds left the clock turns red and pulses and a tick plays every second (twice a second, louder, for the last 3; it follows the sound-effects toggle). Drafts are sent to the host as you type, so whatever's written when time runs out is performed. Anyone who joins mid-game, and the crowd, watches and votes.
- **The battle**: rappers perform one at a time in seat order (P1 → P4) over a random **90 BPM** track (never the same one twice in a row): the same "Get ready" card and 8-beat countdown over the 4 intro bars as Freestyle, then **8 bars, a line every 2 bars**: line _k_ appears exactly on the downbeat of performance bar 2_k_ − 1, big in the middle of the brick wall with the rhyme words in gold, earlier lines dimmed above it. The track fades out after bar 4 + 8 and a golf clap marks the end of each performance.
- **Robot voice**: if the rapper picked TTS, every screen in the room reads each line out as its bar starts, using the browser's built-in speech (`speechSynthesis`, the Web Speech API; it isn't routed through Web Audio, so it plays alongside the beat, which dips to 60% while it speaks). Voices alternate male / female down the order (P1 male, P2 female, …); each browser picks its closest English voice by name (e.g. Daniel, Alex, Aaron, Arthur, Fred, Google UK English Male / Samantha, Karen, Victoria, Moira, Tessa, Google UK English Female, Zira) and speeds up long lines (rate 1.05 up to 1.5) so a line fits its 2 bars. Voices vary by device and browser; without speech support the lines still appear on time.
- **Voting**: after the round's last performance everyone (rappers and the crowd) rates every performance 1–5 stars at once, except their own, with each rapper's 4 lines on their card to re-read. When everyone's voted (or after 30 seconds) the **scoreboard** shows the stars each rapper got this round and their running total. Then the next round, with fresh rhymes. After **round 3** the podium shows total stars and "_Name_ takes the mic!" (ties share it).

### Freestyle

- **A round**: the host starts. Rappers go in order P1 → P4. Each turn plays a backing track picked at random by the host (never the same one twice in a row, and everyone hears the same one): a "Get ready _name_" card over intro bars 1–2, an 8-beat countdown (8 … 1) over intro bars 3–4, then the drums drop for the 16 rap bars. A golf clap (`public/sfx/golf-clap.mp3`) marks the end of the round, and the tail of the track rings out under the vote.
- **The bars**: a karaoke-style list. The current bar sits at the top; the next ones wait below and slide up as each bar finishes, while the finished bar floats up and fades away. Each bar has 4 cells, one per beat: beats 1–3 are free, beat 4 shows the **rhyme word** to land right on the beat. Cells turn green as the beat passes. Bars come in couplets: each couplet uses one rhyming pair (word A, then word B) and gets its own colour (blue, amber, magenta, teal, red, gold, violet, cyan; green is saved for the ball and finished beats). That's 8 pairs per turn, never repeated within a game.
- **Bouncing ball** (green): lands on each cell exactly on the beat, in arcs with a motion streak, driven by the audio clock.
- **Voting**: after each turn everyone except the rapper (other rappers and the crowd) rates it 1–5 stars. When everyone's voted (or after 20 seconds) the rapper's average shows, then the next rapper's up. After the last turn: a podium of average stars and "_Name_ takes the mic!" (ties share it). The host can play again, or everyone heads back to the lobby.
- **Solo practice**: from the home screen, rap 16 bars (Freestyle) over a random track with the ball and prompts, no room or votes.

### Everything else

- **Tracks** (in [`public/tracks/`](public/tracks/)): Brooklyn Old School, Harlem Boom Bap, Detroit Horrorcore, Long Beach G-Funk, The Bronx Jazz Hop, Memphis Dirty South, Nashville Bro Country and Havana Reggaeton, all at 90 BPM (the tempo isn't shown in the game). If a track can't be loaded, a synthesized fallback beat at the same tempo plays instead ([`public/js/beats.js`](public/js/beats.js)).
- **Rooms, links and hosting**: exactly like the other mates games. Create a room and share the 4-letter code or link; link rooms like **/rapmates/mate** are hosted by the first visitor and handed to the next person if the host leaves (rappers in slot order, then the crowd); `?group=<id>` gives an embedding app its own room. Home button in game, music and sound-effect toggles (remembered on your device).

## How it works

There is no game server. Rapmates is peer-to-peer, so it runs on any static host, including GitHub Pages.

- The **host's browser** runs the room ([`public/js/engine.js`](public/js/engine.js)): who's in the room, the mode, turn order, the rhyme pairs, the write clock, voting and results. Others only send the mode and "start" (host), their lines (Write Bars) and their votes. The host trims and limits every line; every screen escapes them when it shows them.
- Players connect over WebRTC with [PeerJS](https://peerjs.com/) ([`public/js/net.js`](public/js/net.js)); add a TURN relay in [`public/js/config.js`](public/js/config.js) for networks that can't connect directly.
- **Staying in time**: the host never streams audio. Each turn is a schedule in the host's clock: the start time of the track's intro (now + 1.5 s), the track and the 8 rhyme pairs. Every browser preloads and decodes all the tracks as soon as it's in a room, keeps estimating the difference between its clock and the host's (NTP-style pings to the host, keeping the answer with the shortest round trip), converts the start time into its own `AudioContext` time and starts the track there, so bar _n_ lands at `start + (n - 1) × 4 × 60 / bpm`. The ball and the bars read the audio output clock every frame, so they're tight to what you hear. Browsers usually agree to within a few tens of milliseconds; if the clock estimate improves mid-turn the beat re-lines itself up. If a browser hasn't been allowed to play sound yet, a "Tap to turn the beat on" button appears and the beat joins in at the right point.

### Files

```
public/
  index.html        markup only
  404.html          GitHub Pages fallback: turns /rapmates/<room> links into ?room=<room>
  css/              base.css, lobby.css, stage.css, overlays.css, writebars.css (loaded in that order)
  js/               config.js, words.js, tracks.js, engine.js, net.js, beats.js, client.js
  tracks/           backing tracks (MP3)
  sfx/              sound effects (golf clap)
test/               node --test suites for the engine, tracks and words
```

The deploy stamps `?v=__BUILD__` on every CSS and JS link in `index.html` with the commit, so players get fresh files straight after a deploy.

### Tracks

Tracks are data in [`public/js/tracks.js`](public/js/tracks.js):

```js
{ id: 'harlem', name: 'Harlem Boom Bap', src: 'tracks/90BPM-Harlem-Boom-Bap.mp3', bpm: 90, offset: 0.067, skipBars: 0, introBars: 4, rapBars: 16, fadeAfterBars: 22 },
```

| Track | BPM | `offset` (bar 1, beat 1) |
|---|---|---|
| Brooklyn Old School | 90 | 0.086 s |
| Harlem Boom Bap | 90 | 0.067 s |
| Detroit Horrorcore | 90 | 0.066 s |
| Long Beach G-Funk | 90 | 0.103 s |
| The Bronx Jazz Hop | 90 | 0.066 s |
| Memphis Dirty South | 90 | 0.096 s |
| Nashville Bro Country | 90 | 0.096 s |
| Havana Reggaeton | 90 | 0.073 s |

**Adding a track**

1. Cut it to the game's structure: **a 4-bar intro, the drums in on bar 5 for 16 bars, then a short tail** (20 bars plus tail). One tempo throughout.
2. Put the MP3 in `public/tracks/`, named `<bpm>BPM-<Name>.mp3`, and add an entry to `TRACKS` (the tests check every file has an entry and vice versa).
3. Set `bpm`, and `offset`: the seconds from the start of the file to beat 1 of bar 1 (the first intro bar). Measure it on the browser's decoded audio, since that's what players hear (MP3 encoder delay is handled the same way): the offsets above were found by fitting the known-tempo beat grid to the drum hits over the whole drum section (high-passed energy onsets in 1 ms steps); every track's hits sit within about 1 ms of its grid. A good first guess: the time of the first drum hit on bar 5, minus 4 bars (4 × 4 × 60 / bpm).
4. Check it by ear with **`?debug&click`**: a metronome clicks on every beat over the track (accented on each bar's downbeat), and the track name, offset and current bar/beat show on screen. The click should sit right on the kick and snare from bar 5.

Write Bars only uses the 90 BPM tracks, and shortens each turn to 8 rap bars with the fade right after them: the engine passes `rapBars: 8` and `fadeAfterBars: introBars + 8` with the turn, and `Tracks.turnSeconds(track, rapBars)` / `Tracks.fadeAt(track, fadeAfterBars)` use them instead of the track's own values.

Optional fields for files that don't quite fit: `skipBars` starts playback that many bars into the file (e.g. a track with an 8-bar intro uses `skipBars: 4`), and `fadeAfterBars` sets when the track fades out over 3 s, counted in bars from the playback start (22 lets two bars of tail ring; use 20 for a track whose drums carry on past bar 20).

## Rhyme pairs

The 60 pairs in [`public/js/words.js`](public/js/words.js). In Freestyle, bar 1 of a couplet ends on word A, bar 2 on word B. In Write Bars each rapper gets 2 of them per round.

| # | A | B |
|---|---|---|
| 1 | knockout | lockout |
| 2 | big time | prime time |
| 3 | hustle | muscle |
| 4 | bag | swag |
| 5 | finesse | success |
| 6 | flex | next |
| 7 | lit | hit |
| 8 | trill | skill |
| 9 | no cap | thunderclap |
| 10 | cramp | champ |
| 11 | mic | strike |
| 12 | flow | show |
| 13 | crown | downtown |
| 14 | rhyme | climb |
| 15 | beat | heat |
| 16 | grind | mind |
| 17 | fresh | mesh |
| 18 | drip | ship |
| 19 | gold | bold |
| 20 | boss | sauce |
| 21 | squad | nod |
| 22 | hype | stripe |
| 23 | vibe | tribe |
| 24 | stack | track |
| 25 | cash | flash |
| 26 | game | fame |
| 27 | street | sweet |
| 28 | block | clock |
| 29 | crew | brand new |
| 30 | bounce | announce |
| 31 | real | deal |
| 32 | shine | line |
| 33 | player | mayor |
| 34 | rocket | pocket |
| 35 | wave | brave |
| 36 | king | bling |
| 37 | slick | quick |
| 38 | mixtape | escape |
| 39 | spotlight | all night |
| 40 | bars | stars |
| 41 | smooth | groove |
| 42 | fire | higher |
| 43 | sneakers | speakers |
| 44 | gravy | wavy |
| 45 | headline | deadline |
| 46 | kicks | tricks |
| 47 | ice | price |
| 48 | clutch | touch |
| 49 | rumble | humble |
| 50 | loud | crowd |
| 51 | boom | room |
| 52 | zone | throne |
| 53 | hip hop | non-stop |
| 54 | flame | name |
| 55 | bass | space |
| 56 | rap | snap |
| 57 | smash | splash |
| 58 | vision | mission |
| 59 | dream | team |
| 60 | GOAT | boat |

## Run locally

```bash
npm install
npm start
```

Open http://localhost:3000 (or http://localhost:3000/mate for the link room). Create a room in one window and join with the code or link from another window or device. An internet connection is still needed to reach the PeerJS service.

## Test

```bash
npm test
```

Covers the room logic (rappers vs crowd, unique names, host handover, turn order, voting rules, averages and ties), the rhyme pairs and the 16-bar couplet schedule, and Write Bars ([`test/writebars.test.js`](test/writebars.test.js)): picking the mode, the write deadline and ending early, 2 unique pairs each and no repeats across rounds, line sanitising, the 4 + 8 bar schedule and line start times, 90 BPM tracks only, star totals over 3 rounds, and late joiners or rappers leaving mid-write, mid-battle or mid-vote.

For testing in the browser, `?debug` shows the track timing (and logs when each Write Bars line appeared against its bar in `__rapmatesDebug.stage.lineLog`), and `?debug&write=10` gives a 10-second write clock (5–60; the host's URL decides).

## Deploy

Every push to `main` runs the tests and publishes the `public/` folder to GitHub Pages ([`.github/workflows/pages.yml`](.github/workflows/pages.yml)).
