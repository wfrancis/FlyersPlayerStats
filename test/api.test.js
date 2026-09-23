'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server');
const { loadRoster } = require('../db');

// Made-up names — the real roster never goes in the repo.
const ROSTER = loadRoster(path.join(__dirname, 'fixtures', 'roster.json'));

function startServer(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-stats-test-'));
  const app = createApp({ dbPath: path.join(dir, 'test.db'), teamName: 'Test Team', roster: ROSTER, ...opts });
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      let cookie = '';
      const call = async (method, url, body, headers = {}) => {
        const res = await fetch(base + url, {
          method,
          headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        const set = res.headers.get('set-cookie');
        if (set) cookie = set.split(';')[0];
        const text = await res.text();
        let data;
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
        return { status: res.status, data, headers: res.headers };
      };
      resolve({
        base,
        call,
        close: () => new Promise((r) => server.close(() => { app.store.close(); fs.rmSync(dir, { recursive: true, force: true }); r(); })),
      });
    });
  });
}

const byNumber = (players, n) => players.find((p) => p.number === n).id;
const statFor = (stats, id) => stats.find((s) => s.id === id);

describe('stats', () => {
  let s;
  let P; // jersey number -> id
  let n = 0;
  const cid = () => `test-tap-${String(++n).padStart(6, '0')}`;
  const tap = (num, stat, delta = 1) => ({ client_id: cid(), player_id: num === null ? null : P(num), stat, delta });
  const send = (gid, taps, device = 'phone-aaaaaaaa') => s.call('POST', `/api/games/${gid}/taps`, { taps }, { 'X-Device-Id': device });
  const newGame = async (date, opponent = 'Test', player_ids) => (await s.call('POST', '/api/games', { date, opponent, ...(player_ids ? { player_ids } : {}) })).data.game.id;

  before(async () => {
    s = await startServer();
    const { data } = await s.call('GET', '/api/players');
    P = (num) => byNumber(data.players, num);
  });
  after(() => s.close());

  test('seeds the 12 skaters once (no goalies; no positions played yet)', async () => {
    const { data } = await s.call('GET', '/api/players');
    assert.equal(data.players.length, 12);
    assert.ok(data.players.every((p) => p.active && p.last_position === null));
  });

  test('new game lists every active player with zeros', async () => {
    const { status, data } = await s.call('POST', '/api/games', { date: '2025-09-20', opponent: 'Rampage' });
    assert.equal(status, 201);
    assert.equal(data.dressed.length, 12);
    assert.equal(data.stats.length, 12);
    assert.deepEqual(data.score, { us: 0, them: 0 });
    assert.ok(data.stats.every((r) => r.g === 0 && r.a === 0 && r.pm === 0));
  });

  test('taps add up per player; our score = our goals; their score = opp taps', async () => {
    const gid = await newGame('2025-09-21', 'Wolves');
    const { status, data } = await send(gid, [
      tap(87, 'g'), tap(5, 'a'), tap(71, 'a'),
      ...[87, 5, 71, 21, 33].map((x) => tap(x, 'pm', 1)),
      tap(null, 'opp'),
      ...[13, 23, 33, 63, 97].map((x) => tap(x, 'pm', -1)),
      tap(87, 'g'),
    ]);
    assert.equal(status, 200);
    assert.equal(data.applied, 15);
    const st = data.game.stats;
    const row = (x) => { const r = statFor(st, P(x)); return [r.g, r.a, r.pts, r.pm]; };
    assert.deepEqual(row(87), [2, 0, 2, 1]);
    assert.deepEqual(row(5), [0, 1, 1, 1]);
    assert.deepEqual(row(33), [0, 0, 0, 0]); // +1 then -1
    assert.deepEqual(row(13), [0, 0, 0, -1]);
    assert.deepEqual(data.game.score, { us: 2, them: 1 });
  });

  test('minus taps correct mistakes; goals/assists/their score never go below 0, +/- can', async () => {
    const gid = await newGame('2025-09-22', 'Hawks');
    const { data } = await send(gid, [
      tap(97, 'g'), tap(97, 'g', -1), tap(97, 'g', -1), // back to 0, extra minus ignored
      tap(55, 'a', -1),
      tap(null, 'opp', -1),
      tap(13, 'pm', -1), tap(13, 'pm', -1),
    ]);
    assert.equal(data.applied, 4);
    assert.equal(statFor(data.game.stats, P(97)).g, 0);
    assert.equal(statFor(data.game.stats, P(55)).a, 0);
    assert.equal(statFor(data.game.stats, P(13)).pm, -2);
    assert.deepEqual(data.game.score, { us: 0, them: 0 });
  });

  test('resending the same taps (retry after lost response) counts them once', async () => {
    const gid = await newGame('2025-09-23', 'Retry');
    const batch = [tap(87, 'g'), tap(5, 'a'), tap(87, 'pm')];
    await send(gid, batch);
    const again = await send(gid, [...batch, tap(21, 'pm')]);
    assert.equal(again.data.applied, 1);
    assert.equal(statFor(again.data.game.stats, P(87)).g, 1);
    assert.equal(statFor(again.data.game.stats, P(21)).pm, 1);
  });

  test('tapping a player who was marked absent adds them to the game', async () => {
    const gid = await newGame('2025-09-24', 'Ducks', [P(5)]);
    const { data } = await send(gid, [tap(87, 'g')]);
    assert.ok(data.game.dressed.includes(P(87)));
    // taking them out of the lineup later keeps them (they have stats)
    const { data: upd } = await s.call('PUT', `/api/games/${gid}`, { player_ids: [P(5)] });
    assert.ok(upd.dressed.includes(P(87)));
    assert.ok(!upd.dressed.includes(P(13)));
  });

  test('warns when another phone tapped the same game in the last few minutes', async () => {
    const gid = await newGame('2025-09-25', 'Two phones');
    await send(gid, [tap(87, 'g')], 'phone-aaaaaaaa');
    const mine = await s.call('GET', `/api/games/${gid}`, undefined, { 'X-Device-Id': 'phone-aaaaaaaa' });
    assert.equal(mine.data.other_phones, 0);
    const other = await s.call('GET', `/api/games/${gid}`, undefined, { 'X-Device-Id': 'phone-bbbbbbbb' });
    assert.equal(other.data.other_phones, 1);
  });

  test('bad taps are rejected as a whole batch', async () => {
    const gid = await newGame('2025-09-26', 'Kings');
    assert.equal((await send(gid, [tap(87, 'g'), { client_id: cid(), player_id: P(5), stat: 'x', delta: 1 }])).status, 400);
    assert.equal((await send(gid, [{ client_id: cid(), player_id: P(5), stat: 'g', delta: 2 }])).status, 400);
    assert.equal((await send(gid, [{ client_id: cid(), player_id: 99999, stat: 'g', delta: 1 }])).status, 400);
    assert.equal((await send(gid, [{ client_id: cid(), stat: 'g', delta: 1 }])).status, 400);
    assert.equal((await send(gid, 'nope')).status, 400);
    assert.equal((await send(99999, [tap(87, 'g')])).status, 404);
    const { data } = await s.call('GET', `/api/games/${gid}`);
    assert.equal(statFor(data.stats, P(87)).g, 0); // nothing from the rejected batch was saved
  });

  test('season totals and player game log add up', async () => {
    const { data } = await s.call('GET', '/api/stats');
    const cole = statFor(data.players, P(87));
    assert.equal(cole.g, 5); // Wolves 2, Retry 1, Ducks 1, Two phones 1
    assert.equal(cole.pm, 2);
    assert.equal(cole.gp, 7); // every game so far (Ducks via auto-add; Kings is past-dated so it counts)
    const { data: pd } = await s.call('GET', `/api/players/${P(87)}`);
    assert.equal(pd.totals.g, 5);
    assert.equal(pd.games.reduce((t, g) => t + g.g, 0), 5);
    assert.equal(pd.games.reduce((t, g) => t + g.pm, 0), pd.totals.pm);
    assert.equal(pd.totals.gp, cole.gp);
    assert.equal(data.goals_for, (await s.call('GET', '/api/games')).data.games.reduce((t, g) => t + g.us, 0));
    assert.deepEqual(data.record, { w: 4, l: 0, t: 3 });
  });

  test('empty future games are not ties and do not add games played', async () => {
    const before = (await s.call('GET', '/api/stats')).data;
    const gid = await newGame('2099-01-01', 'Future');
    const after1 = (await s.call('GET', '/api/stats')).data;
    assert.deepEqual(after1.record, before.record);
    assert.equal(statFor(after1.players, P(5)).gp, statFor(before.players, P(5)).gp);
    assert.equal((await s.call('GET', '/api/games')).data.games.find((x) => x.id === gid).played, false);
    await send(gid, [tap(null, 'opp')]);
    const after2 = (await s.call('GET', '/api/stats')).data;
    assert.equal(after2.record.l, before.record.l + 1);
    assert.equal(statFor(after2.players, P(5)).gp, statFor(before.players, P(5)).gp + 1);
    await s.call('DELETE', `/api/games/${gid}`);
  });

  test('opponent is optional', async () => {
    const { status, data } = await s.call('POST', '/api/games', { date: '2025-10-02', opponent: '  ' });
    assert.equal(status, 201);
    assert.equal(data.game.opponent, 'Opponent');
    await s.call('DELETE', `/api/games/${data.game.id}`);
  });

  test('positions are set per game, default to last game, and can change mid-game', async () => {
    const g1 = await newGame('2025-12-01', 'Pos One', [P(87), P(5), P(13)]);
    await s.call('PUT', `/api/games/${g1}`, { player_ids: [P(87), P(5), P(13)], positions: { [P(87)]: 'c', [P(5)]: 'D' } });
    let d = (await s.call('GET', `/api/games/${g1}`)).data;
    assert.deepEqual([87, 5, 13].map((n) => statFor(d.stats, P(n)).position), ['C', 'D', null]);

    // next game: no positions sent -> everyone starts at last game's position
    const g2 = await newGame('2025-12-02', 'Pos Two', [P(87), P(5), P(13)]);
    d = (await s.call('GET', `/api/games/${g2}`)).data;
    assert.deepEqual([87, 5, 13].map((n) => statFor(d.stats, P(n)).position), ['C', 'D', null]);

    // switch #87 to wing for game 2 only (from the tap board)
    const sw = await s.call('PUT', `/api/games/${g2}/players/${P(87)}`, { position: 'W' });
    assert.equal(statFor(sw.data.stats, P(87)).position, 'W');
    assert.equal(statFor((await s.call('GET', `/api/games/${g1}`)).data.stats, P(87)).position, 'C');
    assert.equal((await s.call('PUT', `/api/games/${g2}/players/${P(87)}`, { position: 'G' })).status, 400);

    // editing the lineup without positions keeps the ones already set
    await s.call('PUT', `/api/games/${g2}`, { player_ids: [P(87), P(5)] });
    d = (await s.call('GET', `/api/games/${g2}`)).data;
    assert.equal(statFor(d.stats, P(87)).position, 'W');

    // a late arrival tapped in gets their last position; the roster remembers the latest one
    const g3 = await newGame('2025-12-03', 'Pos Three', [P(13)]);
    const late = await send(g3, [tap(5, 'a')]);
    assert.equal(statFor(late.data.game.stats, P(5)).position, 'D');
    const roster = (await s.call('GET', '/api/players')).data.players;
    assert.equal(roster.find((p) => p.id === P(87)).last_position, 'W');
    assert.ok(!('position' in roster[0]));

    // season + player page
    const season = (await s.call('GET', '/api/stats')).data;
    assert.deepEqual(statFor(season.players, P(87)).positions, ['C', 'W']);
    const pd = (await s.call('GET', `/api/players/${P(87)}`)).data;
    assert.equal(pd.games.find((g) => g.game_id === g1).position, 'C');
    assert.equal(pd.games.find((g) => g.game_id === g2).position, 'W');
    const csv = (await s.call('GET', '/api/stats.csv')).data;
    assert.match(csv, /87,Riley Frost,Center\/Wing,/);

    for (const g of [g1, g2, g3]) await s.call('DELETE', `/api/games/${g}`);
  });

  test('ids of deleted games and players are never reused', async () => {
    const g1 = await newGame('2025-11-01', 'Gone');
    await s.call('DELETE', `/api/games/${g1}`);
    const g2 = await newGame('2025-11-01', 'New');
    assert.ok(g2 > g1);
    await s.call('DELETE', `/api/games/${g2}`);
    const p1 = (await s.call('POST', '/api/players', { name: 'Temp One' })).data.player.id;
    await s.call('DELETE', `/api/players/${p1}`);
    const p2 = (await s.call('POST', '/api/players', { name: 'Temp Two' })).data.player.id;
    assert.ok(p2 > p1);
    await s.call('DELETE', `/api/players/${p2}`);
  });

  test('a tap that was undone does not keep an absent player in the lineup', async () => {
    const gid = await newGame('2025-11-02', 'Undo', [P(5)]);
    await send(gid, [tap(97, 'a'), tap(97, 'a', -1)]);
    const { data } = await s.call('PUT', `/api/games/${gid}`, { player_ids: [P(5)] });
    assert.ok(!data.dressed.includes(P(97)));
    await s.call('DELETE', `/api/games/${gid}`);
  });

  test('games list marks games created or tapped recently as active', async () => {
    const gid = await newGame('2025-11-03', 'Active');
    const g = (await s.call('GET', '/api/games')).data.games.find((x) => x.id === gid);
    assert.equal(g.active, true);
    const old = (await s.call('GET', '/api/games')).data.games.find((x) => x.opponent === 'Wolves');
    assert.equal(typeof old.active, 'boolean');
    await s.call('DELETE', `/api/games/${gid}`);
  });

  test('shots on goal: counted per player; "–" (null) where nothing was entered', async () => {
    const g1 = await newGame('2025-12-10', 'SOG One', [P(87), P(5), P(13)]);
    const g2 = await newGame('2025-12-11', 'SOG Two', [P(87), P(5), P(13)]); // shots not tracked
    const g3 = await newGame('2025-12-12', 'Nothing entered', [P(87), P(5), P(13)]);
    const r = await send(g1, [tap(87, 's'), tap(87, 's'), tap(87, 's', -1), tap(87, 's'), tap(5, 's'), tap(5, 's', -1), tap(5, 's', -1)]);
    assert.equal(statFor(r.data.game.stats, P(87)).s, 2);
    assert.equal(statFor(r.data.game.stats, P(5)).s, 0); // never below 0
    assert.equal(r.data.game.tracked.s, 1);
    await send(g2, [tap(13, 'g')]);
    const b2 = (await s.call('GET', `/api/games/${g2}`)).data;
    assert.deepEqual([b2.tracked.any, b2.tracked.s], [1, 0]);

    const pd = (await s.call('GET', `/api/players/${P(13)}`)).data;
    const row = (gid) => pd.games.find((g) => g.game_id === gid);
    assert.deepEqual([row(g1).g, row(g1).s], [0, 0]); // stats + shots were entered in game 1: real zeros
    assert.deepEqual([row(g2).g, row(g2).s], [1, null]); // game 2: goals entered, shots not tracked
    assert.deepEqual([row(g3).g, row(g3).a, row(g3).pts, row(g3).pm, row(g3).s], [null, null, null, null, null]); // nothing entered
    assert.equal(pd.totals.s, 0);

    const season = (await s.call('GET', '/api/stats')).data;
    assert.equal(statFor(season.players, P(87)).s, 2);
    // season totals are always numbers: a player who only played in untracked games shows 0s (– is per game only)
    const kid = (await s.call('POST', '/api/players', { name: 'New Kid', number: 44 })).data.player.id;
    await s.call('PUT', `/api/games/${g3}`, { player_ids: [P(87), P(5), P(13), kid] });
    const k = statFor((await s.call('GET', '/api/stats')).data.players, kid);
    assert.deepEqual([k.gp, k.g, k.a, k.pts, k.pm, k.s], [1, 0, 0, 0, 0, 0]);
    const kd = (await s.call('GET', `/api/players/${kid}`)).data;
    assert.deepEqual([kd.totals.g, kd.totals.s], [0, 0]);
    assert.equal(kd.games[0].g, null); // but that game's row still shows –
    for (const g of [g1, g2, g3]) await s.call('DELETE', `/api/games/${g}`);
    await s.call('DELETE', `/api/players/${kid}`);
  });

  test('a tap that was undone does not turn "–" into 0', async () => {
    const g1 = await newGame('2025-12-20', 'Undo SOG', [P(87), P(5)]);
    await send(g1, [tap(87, 'g')]); // stats entered, shots not tracked
    await send(g1, [tap(5, 's'), tap(5, 's', -1)]); // accidental + SOG, then Undo
    const d = (await s.call('GET', `/api/games/${g1}`)).data;
    assert.deepEqual([d.tracked.any, d.tracked.s], [1, 0]);
    assert.equal((await s.call('GET', `/api/players/${P(87)}`)).data.games.find((g) => g.game_id === g1).s, null);
    const g2 = await newGame('2025-12-21', 'Undo empty', [P(87), P(5)]);
    await send(g2, [tap(5, 'g'), tap(5, 'g', -1)]); // accidental + Goal, then Undo, on an empty game
    const e = (await s.call('GET', `/api/games/${g2}`)).data;
    assert.deepEqual([e.tracked.any, e.tracked.s], [0, 0]);
    const row = (await s.call('GET', `/api/players/${P(5)}`)).data.games.find((g) => g.game_id === g2);
    assert.deepEqual([row.g, row.a, row.pts, row.pm, row.s], [null, null, null, null, null]);
    for (const g of [g1, g2]) await s.call('DELETE', `/api/games/${g}`);
  });

  test('CSV export', async () => {
    const { status, data, headers } = await s.call('GET', '/api/stats.csv');
    assert.equal(status, 200);
    assert.match(headers.get('content-type'), /text\/csv/);
    assert.match(data, /^Number,Player,Positions played,Games,Goals,Assists,Points,Plus\/Minus,Shots on goal\r\n/);
    assert.match(data, /87,Riley Frost,,7,5,0,5,2,0\r\n/); // season totals are numbers, never "-" 
  });

  test('delete game removes its stats from season totals', async () => {
    const before = (await s.call('GET', '/api/stats')).data;
    const gid = await newGame('2025-10-03', 'Temp');
    await send(gid, [tap(87, 'g')]);
    assert.equal((await s.call('DELETE', `/api/games/${gid}`)).status, 200);
    const afterDel = (await s.call('GET', '/api/stats')).data;
    assert.equal(statFor(afterDel.players, P(87)).g, statFor(before.players, P(87)).g);
    assert.equal(afterDel.games, before.games);
    assert.equal((await s.call('GET', `/api/games/${gid}`)).status, 404);
  });

  test('players: add, edit, remove (hide if they have history)', async () => {
    const add = await s.call('POST', '/api/players', { name: '  New   Kid ', number: 9 });
    assert.equal(add.status, 201);
    assert.equal(add.data.player.name, 'New Kid');
    assert.equal((await s.call('POST', '/api/players', { name: '', number: 9 })).status, 400);
    assert.equal((await s.call('POST', '/api/players', { name: 'X', number: 100 })).status, 400);
    const upd = await s.call('PUT', `/api/players/${add.data.player.id}`, { number: 10 });
    assert.equal(upd.data.player.number, 10);
    assert.deepEqual((await s.call('DELETE', `/api/players/${add.data.player.id}`)).data, { removed: 'deleted' });
    assert.deepEqual((await s.call('DELETE', `/api/players/${P(87)}`)).data, { removed: 'hidden' });
    const { data } = await s.call('GET', '/api/stats');
    assert.ok(statFor(data.players, P(87)), 'hidden player with stats still in season stats');
    await s.call('PUT', `/api/players/${P(87)}`, { active: true });
  });

  test('validation: bad dates, bad ids, non-JSON writes', async () => {
    assert.equal((await s.call('POST', '/api/games', { date: '2026-02-30', opponent: 'X' })).status, 400);
    assert.equal((await s.call('POST', '/api/games', { date: 'tomorrow', opponent: 'X' })).status, 400);
    assert.equal((await s.call('POST', '/api/games', { date: '2026-02-03', opponent: 'x'.repeat(61) })).status, 400);
    assert.equal((await s.call('GET', '/api/games/abc')).status, 404);
    assert.equal((await s.call('GET', '/api/games/99999')).status, 404);
    const form = await s.call('POST', '/api/players', undefined, { 'Content-Type': 'application/x-www-form-urlencoded' });
    assert.equal(form.status, 415);
  });
});

describe('team code', () => {
  let s;
  before(async () => { s = await startServer({ teamCode: 'GoFlyers' }); });
  after(() => s.close());

  test('API is locked until the code is entered (case-insensitive)', async () => {
    assert.equal((await s.call('GET', '/api/config')).data.needsCode, true);
    assert.equal((await s.call('GET', '/api/games')).status, 401);
    assert.equal((await s.call('GET', '/api/stats.csv')).status, 401);
    assert.equal((await s.call('GET', '/api/backup')).status, 401);
    assert.equal((await s.call('POST', '/api/login', { code: 'nope' })).status, 401);
    const ok = await s.call('POST', '/api/login', { code: '  goflyers ' });
    assert.equal(ok.status, 200);
    assert.equal((await s.call('GET', '/api/games')).status, 200);
    assert.equal((await s.call('GET', '/api/config')).data.authed, true);
  });

  test('static page and health check are public', async () => {
    assert.equal((await s.call('GET', '/healthz')).status, 200);
    const home = await s.call('GET', '/');
    assert.equal(home.status, 200);
    assert.match(home.data, /<title>/);
    assert.match(home.headers.get('content-security-policy'), /script-src 'self'/);
  });

  test('a cookie computed from the code alone is rejected', async () => {
    const crypto = require('node:crypto');
    const forged = crypto.createHash('sha256').update('team-stats:v1:goflyers').digest('hex');
    const res = await fetch(`${s.base}/api/players`, { headers: { Cookie: `team_auth=${forged}` } });
    assert.equal(res.status, 401);
  });

  test('backup downloads a real SQLite file', async () => {
    const res = await s.call('GET', '/api/backup');
    assert.equal(res.status, 200);
    assert.ok(String(res.data).startsWith('SQLite format 3'));
  });
});

describe('starting roster', () => {
  test('a new database with no roster file starts empty', () => {
    const { openDb: open } = require('../db');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-stats-empty-'));
    const store = open(path.join(dir, 'x.db'));
    assert.equal(store.listPlayers().length, 0);
    assert.deepEqual(loadRoster(path.join(dir, 'missing.json')), []);
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('upgrading a database from the first release', () => {
  test('drops the old goalie/skater column, adds per-game positions, keeps the players', () => {
    const { DatabaseSync } = require('node:sqlite');
    const { openDb } = require('../db');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-stats-migrate-'));
    const file = path.join(dir, 'old.db');
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE players (id INTEGER PRIMARY KEY, name TEXT NOT NULL, number INTEGER,
                position TEXT NOT NULL DEFAULT 'S' CHECK (position IN ('S', 'G')), active INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL DEFAULT (datetime('now')));
              CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
              INSERT INTO meta VALUES ('seeded', 'x');
              INSERT INTO players (name, number, position) VALUES ('Riley Frost', 87, 'S'), ('Some Goalie', 30, 'G');`);
    old.close();
    const store = openDb(file);
    // the old goalie/skater column is gone from players; positions now live on each game's lineup
    const playerCols = store.db.prepare("SELECT name FROM pragma_table_info('players')").all().map((r) => r.name);
    const lineupCols = store.db.prepare("SELECT name FROM pragma_table_info('game_players')").all().map((r) => r.name);
    assert.ok(!playerCols.includes('position'));
    assert.ok(lineupCols.includes('position'));
    assert.equal(store.listPlayers().length, 2);
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 3);
    store.close();
    const again = openDb(file); // running again is a no-op
    assert.equal(again.listPlayers().length, 2);
    again.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('upgrading the live database (v2) to shots on goal', () => {
  test('keeps every tap and accepts shots afterwards', () => {
    const { DatabaseSync } = require('node:sqlite');
    const { openDb } = require('../db');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-stats-sog-'));
    const file = path.join(dir, 'v2.db');
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO meta VALUES ('seeded', 'x');
      CREATE TABLE players (id INTEGER PRIMARY KEY, name TEXT NOT NULL, number INTEGER, active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE games (id INTEGER PRIMARY KEY, date TEXT NOT NULL, opponent TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE game_players (game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
        player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE, position TEXT CHECK (position IN ('C', 'W', 'D')),
        PRIMARY KEY (game_id, player_id));
      CREATE TABLE stat_events (id INTEGER PRIMARY KEY, game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
        player_id INTEGER REFERENCES players(id) ON DELETE CASCADE, stat TEXT NOT NULL CHECK (stat IN ('g', 'a', 'pm', 'opp')),
        delta INTEGER NOT NULL CHECK (delta IN (-1, 1)), client_id TEXT UNIQUE, device_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')), CHECK ((stat = 'opp') = (player_id IS NULL)));
      INSERT INTO players (id, name, number) VALUES (1, 'Riley Frost', 87);
      INSERT INTO games (id, date, opponent) VALUES (1, '2025-09-20', 'Old');
      INSERT INTO game_players VALUES (1, 1, 'C');
      INSERT INTO stat_events (game_id, player_id, stat, delta, client_id) VALUES (1, 1, 'g', 1, 'old-tap-0001'), (1, 1, 'pm', 1, 'old-tap-0002');
      INSERT INTO stat_events (game_id, player_id, stat, delta, client_id) VALUES (1, NULL, 'opp', 1, 'old-tap-0003');
      PRAGMA user_version = 2;`);
    old.close();
    const store = openDb(file);
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 3);
    let g = store.getGame(1);
    assert.deepEqual(g.score, { us: 1, them: 1 });
    assert.equal(g.stats[0].pm, 1);
    const r = store.addTaps(1, [{ client_id: 'new-shot-0001', player_id: 1, stat: 's', delta: 1 },
      { client_id: 'old-tap-0001', player_id: 1, stat: 'g', delta: 1 }]); // resent old tap still deduped
    assert.equal(r.applied, 1);
    g = store.getGame(1);
    assert.deepEqual([g.stats[0].g, g.stats[0].s], [1, 1]);
    const idx = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'stat_events'").all().map((x) => x.name);
    assert.ok(idx.includes('stat_events_game_idx') && idx.includes('stat_events_player_idx'));
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
