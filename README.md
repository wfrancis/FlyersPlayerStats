# Flyers Player Stats — 12U A Green

Phone-friendly tracker for **goals, assists and plus/minus, per player, per game**, entered live at the rink.
Node 24 + built-in SQLite (`node:sqlite`), plain HTML/JS, no build step. Skaters only.

## How it works (for parents)

1. **＋ New game.** The opponent is optional. Each player has **C / W / D / OUT**: tap where they play today, or OUT if they're not here.
   Everyone starts at the position they played last game.
2. **The game screen** lists every player with **− / +** for **Goals**, **Assists** and **Plus/Minus**:
   - **We score:** + Goal for the scorer, + Assist for who assisted, and **+** on +/− for each of our skaters on the ice.
   - **They score:** **+1** on "Their goals", and **−** on +/− for each of our skaters on the ice.
   - Mistake? Tap the opposite button, or **Undo** (always in the same spot at the top).
   - Tap a player's **C / W / D** tag to switch their position for this game.
3. Taps are saved on the phone first and sent in the background, so bad rink signal is fine. The screen stays awake during a game.
   One person per game should tap; the app warns if a second phone is tapping the same game.
4. The **home page** shows recent games and the **season totals** (record, goals for/against, and each player's GP, G, A, PTS, +/− and positions).
   Tap a name for game-by-game stats; download everything as a spreadsheet.

## Run locally

Requires Node 24+ (for `node:sqlite`).

```bash
npm install
npm start          # http://localhost:3000, data in ./data/stats.db
npm test
```

Env vars: `PORT`, `DB_PATH`, `TEAM_NAME`, `TEAM_CODE` (passcode; leave unset for none), `ROSTER_FILE`.

### Starting roster

Players' names are **not** in this repo. A brand-new database is seeded from `roster.json` (gitignored), if present:

```json
[["First Last", 87], ["Another Kid", 5]]
```

Without it the app starts with an empty roster; add players on the **Roster** tab.

## Deploy (Fly.io)

One machine + one volume. SQLite can't be shared across machines, so never scale past 1.

```bash
fly apps create flyers-12u-green
fly volumes create stats_data --region sjc --size 1 --yes
fly secrets set TEAM_CODE=yourcode
fly deploy --ha=false
```

Change the passcode any time with `fly secrets set TEAM_CODE=newcode`; everyone re-enters it once.

**Backups:** Fly snapshots the volume daily. You can also download the whole database from **Roster → Full backup file**.
