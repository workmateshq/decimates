# Rapmates

A party rap battle for up to 4 mates, plus a crowd. Everyone's in the same room (or on a call): the game drops the beat, a bouncing ball keeps time and rhyme prompts tell you which word to land on the 4th beat of every bar. Spit 16 bars each, the room rates you out of 5 stars, and the best average takes the mic. Play it at **https://workmateshq.github.io/rapmates/** or jump straight into the shared room at **https://workmateshq.github.io/rapmates/mate**.

- **Rappers and the crowd**: the first 4 people in a room get the P1–P4 slots; everyone after that joins the **crowd** (shown as "Crowd: N" in the lobby). Everybody gets a real rapper's name (half men, half women, unique in the room). Between games, a free slot goes to whoever's waited longest in the crowd.
- **No mics needed**: nobody's audio is sent anywhere. Every screen plays the same beat and shows the same bars at the same moment; you rap out loud.
- **A round**: the host picks the beat and starts. Rappers go in order P1 → P4. Each turn opens with a "Get ready: _name_ is on the mic" card, a 4-beat count-in (3, 2, 1, GO!), then 16 bars.
- **The bars**: a karaoke-style list. The current bar sits at the top; the next ones wait below and slide up as each bar finishes, while the finished bar floats up and fades away. Each bar has 4 cells, one per beat: beats 1–3 are free, beat 4 shows the **rhyme word** to land right on the beat. Cells turn green as the beat passes. Bars come in couplets: each couplet uses one rhyming pair (word A, then word B) and gets its own colour (blue, amber, magenta, teal, red, gold, violet, cyan; green is saved for the ball and finished beats). That's 8 pairs per turn, never repeated within a game.
- **Bouncing ball** (green): lands on each cell exactly on the beat, in arcs with a motion streak, driven by the audio clock.
- **Voting**: after each turn everyone except the rapper (other rappers and the crowd) rates it 1–5 stars. When everyone's voted (or after 20 seconds) the rapper's average shows, then the next rapper's up. After the last turn: a podium of average stars and "_Name_ takes the mic!" (ties share it). The host can play again, or everyone heads back to the lobby.
- **Solo practice**: from the home screen, pick a beat and rap 16 bars with the ball and prompts, no room or votes.
- **Beats**: "808 Trap · 130 BPM" (half-time clap, rattling hats with triplet rolls, sliding 808s, a dark bell and pad) and "Boom Bap · 90 BPM" (swung dusty drums, a crunchy bit-crushed chord stab, upright-style bass and vinyl crackle). Both are synthesized live with the Web Audio API.
- **Rooms, links and hosting**: exactly like the other mates games. Create a room and share the 4-letter code or link; link rooms like **/rapmates/mate** are hosted by the first visitor and handed to the next person if the host leaves (rappers in slot order, then the crowd); `?group=<id>` gives an embedding app its own room. Home button in game, music and sound-effect toggles (remembered on your device).

## How it works

There is no game server. Rapmates is peer-to-peer, so it runs on any static host, including GitHub Pages.

- The **host's browser** runs the room ([`public/engine.js`](public/engine.js)): who's in the room, turn order, the rhyme pairs, voting and results. Others only send "start" (host), "pick beat" (host) and their votes.
- Players connect over WebRTC with [PeerJS](https://peerjs.com/) ([`public/net.js`](public/net.js)); add a TURN relay in [`public/config.js`](public/config.js) for networks that can't connect directly.
- **Staying in time**: the host never streams audio. Each turn is a schedule in the host's clock: the start time (now + 3.5 s for the "Get ready" card), the tempo and the 8 rhyme pairs. Every browser keeps estimating the difference between its clock and the host's (NTP-style pings to the host, keeping the answer with the shortest round trip), converts the start time into its own `AudioContext` time and schedules the beat there. The ball and the bars read the audio output clock every frame, so they're tight to what you hear. Browsers usually agree to within a few tens of milliseconds; if the clock estimate improves mid-turn the beat re-lines itself up. If a browser hasn't been allowed to play sound yet, a "Tap to turn the beat on" button appears and the beat joins in at the right point.

### Swapping in real beats (MP3)

The synthesized beats are placeholders that will likely be replaced by real MP3 loops. In [`public/beats.js`](public/beats.js), give a `CATALOGUE` entry:

```js
trap: { name: '808 Trap', bpm: 130, src: 'assets/beats/trap.mp3', offset: 0.05, loopBars: 8 },
```

- `src`: the loop file; `bpm`: its tempo (also sent to everyone as the game tempo); `offset`: seconds from the start of the file to beat 1 of the first bar; `loopBars` (optional): loop length in bars (default: the whole file).
- Bar 0 of a turn is the count-in, so the loop starts one bar before the first rap bar. The beat scheduler still runs (for `onBeat` callbacks), it just doesn't play the synth drums.

## Rhyme pairs

The 60 pairs in [`public/words.js`](public/words.js). Bar 1 of a couplet ends on word A, bar 2 on word B.

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

Covers the room logic (rappers vs crowd, unique names, host handover, turn order, voting rules, averages and ties), the rhyme pairs and the 16-bar couplet schedule.

## Deploy

Every push to `main` runs the tests and publishes the `public/` folder to GitHub Pages ([`.github/workflows/pages.yml`](.github/workflows/pages.yml)).
