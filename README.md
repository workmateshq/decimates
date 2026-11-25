# Decimates

A party joke-writing game for 1 to 8 mates, plus a voting crowd. Everyone writes the funniest answers they can to silly prompts, the jokes go head to head on lit sticks of dynamite, and the room votes. The winning joke **explodes**.

Play it at **https://workmateshq.github.io/decimates/**, or jump straight into a shared room at **https://workmateshq.github.io/decimates/mate**.

## How to play

- **Players and the crowd**: the first 8 people in a room get the P1–P8 seats. Everyone after that joins the **crowd**, and so does anyone who arrives mid-game. The crowd votes but doesn't write.
- **Names**: everybody picks their own name (up to 16 characters) the first time they create or join a room. It's remembered on that device. If two people pick the same name, the second one gets a number ("Zak 2").
- **Starting**: like Rapmates, a room can start with just you (practice) or up to 8 players. The host presses start.
- **Practice**: when nobody else can vote on a matchup (playing alone, or 2 players with no crowd), voting is skipped and every answer goes off for no points.
- **Look**: dark panels over a slow hypnotic spiral. Each joke is a paper label tied to a bundle of dynamite; its fuse burns down with the vote clock.
- **Intro**: every game opens with a 33-second "How to play" screen. A voiceover ([`public/sound/intro-vo.mp3`](public/sound/intro-vo.mp3)) explains the rules while bullet points appear in time with it. It plays through the sound-effects toggle, and late joiners pick it up part-way through. The host can skip it.

### Rounds 1 and 2: head to head

1. **Dealing**: each round the host deals one prompt per player, in a ring. Player _i_ gets prompts _i_ and _i_ + 1, so every prompt goes to exactly 2 players and every player gets exactly 2 prompts. Nobody sees the same prompt twice in a game.
2. **Writing (90 seconds)**: answer both prompts, up to 80 characters each.
   - Stuck? **Stock joke** fills in an emergency gag.
   - **Light the fuse** locks your answers in. You can edit them until time runs out.
   - Whatever you've typed when the clock hits zero is used. Empty answers become "(no answer)".
3. **Matchups**: the prompts come up one at a time.
   - The prompt appears big, then docks at the top of the screen.
   - The two answers fade in on bundles of dynamite. They're anonymous while voting.
   - The announcer (your browser's speech) reads the prompt and both answers.
4. **Voting (15 seconds)**: everyone except the two authors votes for their favourite. That means the other players plus the crowd. Voters' faces appear on the answer they picked.
5. **The reveal**: the authors and the vote split are shown. The winner's fuse burns out and it goes off: a flash, a shockwave, sparks and bits of stick, then smoke that billows over the screen while the label flies from the bundle into the middle of the screen.
6. **Scoreboard**: after every matchup, the scoreboard shows the round's points and running totals.
   - Each player presses **Play next round**. The next round starts when everyone has opted in, or after 30 seconds with whoever did.
   - If nobody opts in, the game ends.

### Round 3: the final

- Everyone answers the **same** prompt, then all the answers go up at once.
- Everyone votes for **up to 3 favourites** (not their own) within 30 seconds.
- About **1 game in 3**, the final is **Caption this comic**: players caption a public-domain *Buck Ryan* strip instead of answering a prompt.
- The final ends on the podium.

### Scoring

| What | Points |
| --- | --- |
| Each vote your answer gets | 100 × the round number (round 1: 100, round 2: 200, round 3: 300) |
| **Clean sweep**: you win a head-to-head with every vote | +250 bonus, shown on the winning card, with confetti |
| A tie | Each answer keeps the points for its own votes. There's no clean-sweep bonus, and both sticks go boom |
| Nobody votes | Nobody scores |

The final has no clean-sweep bonus. The player with the most points at the end wins; ties share the win.

### Leaving and joining

- **A player leaves mid-write**: their answers become "(no answer)".
- **An author leaves mid-matchup**: their answer stays in play.
- **The host leaves**: the room hands over to another player.
- **Late joiners**: they watch and vote from the crowd.

## Prompts

All the prompts, stock jokes and comic settings are in [`public/js/prompts.js`](public/js/prompts.js):

- **252 original fill-in-the-blank prompts**: everything from safe-for-work office humour to the downright silly and the slightly cheeky.
- **50 stock jokes** for the **Stock joke** button.
- **The comics**: 9 *Buck Ryan* strips in [`public/img/comics/`](public/img/comics/).

Every prompt must be unique; the tests check this.

## How it works

There is no game server. Decimates is peer-to-peer, so it runs on any static host, including GitHub Pages.

- **The host's browser runs the room** ([`public/js/engine.js`](public/js/engine.js), a `GameRoom`). It handles:
  - who's in the room;
  - dealing;
  - the write clock and the matchup steps (show, vote, reveal), each with a host deadline;
  - scoring and results.
- **Other players only send inputs**:
  - `answer {promptId, text}`
  - `done` / `edit`
  - `vote {matchup, choice: 'a' | 'b'}`, or `{matchup, choices: [...]}` in the final
  - `nextRound`
  - `skipIntro`
- **Safety**: the host sanitises and limits every answer, and every screen escapes answers before showing them.
- **Connections**: players connect over WebRTC with [PeerJS](https://peerjs.com/) ([`public/js/net.js`](public/js/net.js)). For networks that can't connect directly, add a TURN relay in [`public/js/config.js`](public/js/config.js).
- **Audio**: one `AudioContext` with a sound-effect gain and toggle (no background music yet).
  - The sound effects (whistle, boing, fuse hiss, boom) are synthesised in the browser.
  - The announcer uses `speechSynthesis` and follows the sound-effects toggle.
  - At the end of a matchup the host picks the stinger line, so everyone hears the same one.

### Files

```
public/
  index.html        markup only
  404.html          GitHub Pages fallback: turns /decimates/<room> links into ?room=<room>
  css/              base.css, lobby.css, game.css, matchup.css, overlays.css (loaded in that order)
  js/               config.js, prompts.js, engine.js, net.js, client.js
  img/comics/       Buck Ryan strips for the comic final
  sound/            the intro voiceover
test/               node --test suite for the engine and prompts
```

The deploy stamps `?v=__BUILD__` on every CSS and JS link in `index.html` with the commit, so players get fresh files straight after a deploy.

## Run locally

```
npm install
npm start
```

Open http://localhost:3000, create a room in one window, then join from another window or device. An internet connection is still needed to reach the PeerJS service.

## Test

```
npm test
```

The tests cover:

- **Dealing**: ring dealing, with no repeat prompts across rounds.
- **Voting**: authors can't vote on their own matchup; the crowd and late joiners can vote.
- **Scoring**: the scoring maths, clean sweeps and ties.
- **The final**: the comic final and multi-pick votes.
- **Players**: leavers and host handover.
- **Flow**: the next-round opt-in, and the intro and skipping it.

**Debug URL options** (the host's URL decides):

| Option | What it does |
| --- | --- |
| `?debug&write=15` | 15-second write clock (5–60) |
| `&nointro` | Skip the intro |
| `&min=3` | Require at least that many players to start |
| `&comic=1` / `&comic=0` | Force or rule out the comic final |

## Deploy

Every push to `main` runs the tests and publishes the `public/` folder to GitHub Pages ([`.github/workflows/pages.yml`](.github/workflows/pages.yml)). The build and deploy jobs are separate.

## Credits

- **Avatars**: [“Initial Face”](https://www.dicebear.com/styles/initial-face/) by [DiceBear](https://www.dicebear.com), licensed under [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). Each player's face is seeded by their name, so everyone in the room sees the same one.
- **Comics**: *Buck Ryan* strips, public domain. FYI the Buck Ryan comic strip ran in the Daily Mirror from 22 March 1937 to July 1962.
- **Fonts**: [Archivo](https://fonts.google.com/specimen/Archivo) and [Comic Neue](https://fonts.google.com/specimen/Comic+Neue) (the joke labels), from Google Fonts under the SIL Open Font License.
- **Code**: built on the [Rapmates](https://github.com/workmateshq/rapmates) engine. All prompts and stock jokes are original.
