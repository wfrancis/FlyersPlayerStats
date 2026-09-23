'use strict';
// Data layer: SQLite (built into Node 24) + stat totals.
//
// Stats are entered live, per player, by tapping + / − on Goals, Assists and Plus/Minus.
// Every tap is stored as one row in stat_events (delta +1 or −1), so:
//   * totals are just sums (per game, per season, per player),
//   * a tap sent twice (bad signal, retry) is stored once (client_id is unique),
//   * nothing is ever overwritten — two phones' taps both count.
// Our score = sum of our players' goals. Their score = the 'opp' counter.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync, backup } = require('node:sqlite');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (msg) => new HttpError(400, msg);
const notFound = (what) => new HttpError(404, `${what} not found`);

// g = goal, a = assist, pm = plus/minus, s = shot, opp = their goal (no player).
const STATS = ['g', 'a', 'pm', 's', 'opp'];
const POSITIONS = { C: 'Center', W: 'Wing', D: 'Defense' };
const NEVER_NEGATIVE = new Set(['g', 'a', 's', 'opp']);

// One row per tap. Shared by the base schema and the migration that added shots.
const statEventsTable = (name) => `
CREATE TABLE IF NOT EXISTS ${name} (
  id         INTEGER PRIMARY KEY,
  game_id    INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  player_id  INTEGER REFERENCES players(id) ON DELETE CASCADE,
  stat       TEXT NOT NULL CHECK (stat IN ('g', 'a', 'pm', 's', 'opp')),
  delta      INTEGER NOT NULL CHECK (delta IN (-1, 1)),
  client_id  TEXT UNIQUE,
  device_id  TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((stat = 'opp') = (player_id IS NULL))
);`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS players (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  number     INTEGER,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS games (
  id         INTEGER PRIMARY KEY,
  date       TEXT NOT NULL,
  opponent   TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Who played in a game (drives games played + who shows on the game screen).
-- Base schema of the first release; game_players.position is added by MIGRATIONS.
CREATE TABLE IF NOT EXISTS game_players (
  game_id   INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  PRIMARY KEY (game_id, player_id)
);
${statEventsTable('stat_events')}
CREATE INDEX IF NOT EXISTS stat_events_game_idx ON stat_events(game_id);
CREATE INDEX IF NOT EXISTS stat_events_player_idx ON stat_events(player_id);
CREATE INDEX IF NOT EXISTS game_players_player_idx ON game_players(player_id);
`;

// Schema changes after the first release go here. Each runs once, in order (PRAGMA user_version).
const hasColumn = (db, table, col) => db.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name = ?`).get(col);
const MIGRATIONS = [
  // 1: skaters only — drop the goalie/skater position column from the first release.
  (db) => {
    if (hasColumn(db, 'players', 'position')) db.exec('ALTER TABLE players DROP COLUMN position');
  },
  // 2: the position each skater played in each game — C (center), W (wing) or D (defense).
  //    Positions change from game to game, so they live on the lineup, not on the player.
  (db) => {
    if (!hasColumn(db, 'game_players', 'position')) {
      db.exec("ALTER TABLE game_players ADD COLUMN position TEXT CHECK (position IN ('C', 'W', 'D'))");
    }
  },
  // 3: shots. SQLite can't change a CHECK constraint, so copy the taps into a table that allows 's'.
  (db) => {
    const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'stat_events'").get()?.sql || '';
    if (sql.includes("'s'")) return;
    db.exec(`${statEventsTable('stat_events_new')}
      INSERT INTO stat_events_new (id, game_id, player_id, stat, delta, client_id, device_id, created_at)
        SELECT id, game_id, player_id, stat, delta, client_id, device_id, created_at FROM stat_events;
      DROP TABLE stat_events;
      ALTER TABLE stat_events_new RENAME TO stat_events;
      CREATE INDEX IF NOT EXISTS stat_events_game_idx ON stat_events(game_id);
      CREATE INDEX IF NOT EXISTS stat_events_player_idx ON stat_events(player_id);`);
  },
];

// ---------- input cleaning ----------

function cleanText(v, field, max) {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  if (!s) throw bad(`${field} is required`);
  if (s.length > max) throw bad(`${field} is too long (max ${max} characters)`);
  return s;
}

// Opponent is optional so a game can be started in one tap at the rink.
function cleanOpponent(v) {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s ? cleanText(s, 'Opponent', 60) : 'Opponent';
}

function cleanNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 99) throw bad('Jersey number must be 0–99');
  return n;
}

function cleanPosition(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim().toUpperCase();
  if (!POSITIONS[s]) throw bad('Position must be Center, Wing or Defense');
  return s;
}

function cleanDate(v) {
  const s = String(v ?? '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw bad('Date must look like 2026-09-22');
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d || y < 2000 || y > 2100) {
    throw bad('That date does not exist');
  }
  return s;
}

function cleanId(v, what = 'id') {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) throw bad(`Bad ${what}`);
  return n;
}

function cleanIds(v, what = 'player') {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw bad(`Expected a list of ${what}s`);
  return [...new Set(v.map((x) => cleanId(x, what)).filter(Boolean))];
}

const cleanToken = (v) => (typeof v === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(v) ? v : null);

// ---------- helpers ----------

// Positions per game, keyed by player: { player_id: 'C' | 'W' | 'D' } for the ones that were given.
function cleanPositions(v, allowedIds) {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw bad('Positions must be a list of player → C/W/D');
  const out = {};
  for (const [k, pos] of Object.entries(v)) {
    const id = cleanId(k, 'player');
    if (!allowedIds.has(id)) continue; // only players in this lineup
    const clean = cleanPosition(pos);
    if (clean) out[id] = clean;
  }
  return out;
}

// The position each player played most recently — the default for the next game.
const LAST_POSITION = `(SELECT gp.position FROM game_players gp JOIN games g ON g.id = gp.game_id
   WHERE gp.player_id = p.id AND gp.position IS NOT NULL ORDER BY g.date DESC, g.id DESC LIMIT 1)`;

// s: {g, a, pm, s}. A missing value counts as 0; null means "nothing was entered" (shown as –).
function statRow(p, s = {}, gp = 0, extra = {}) {
  const v = (k) => (s?.[k] === undefined ? 0 : s[k]);
  const g = v('g');
  const a = v('a');
  return {
    id: p.id,
    name: p.name,
    number: p.number,
    ...extra,
    active: !!p.active,
    gp,
    g,
    a,
    pts: g === null ? null : g + (a ?? 0),
    pm: v('pm'),
    s: v('s'),
  };
}

const byNumber = (a, b) => (a.number ?? 999) - (b.number ?? 999) || a.name.localeCompare(b.name);

// SQL pieces shared by the game list, season record and player log.
const SCORE_COLS = `
  (SELECT COALESCE(SUM(e.delta), 0) FROM stat_events e WHERE e.game_id = g.id AND e.stat = 'g')   AS us,
  (SELECT COALESCE(SUM(e.delta), 0) FROM stat_events e WHERE e.game_id = g.id AND e.stat = 'opp') AS them,
  -- "played" = someone entered stats, or the date is over. An empty game created today (or by
  -- accident) doesn't count as a tie or as a game played. The server clock is UTC, which is already
  -- "tomorrow" during a US evening game, so the date rule waits an extra day.
  (EXISTS (SELECT 1 FROM stat_events e WHERE e.game_id = g.id) OR g.date < date('now', '-1 day')) AS played`;

// ---------- store ----------

class Store {
  constructor(db) {
    this.db = db;
    this.cache = new Map();
  }

  q(sql) {
    let st = this.cache.get(sql);
    if (!st) this.cache.set(sql, (st = this.db.prepare(sql)));
    return st;
  }

  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  close() {
    this.db.close();
  }

  meta(key) {
    return this.q('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
  }

  async backupTo(file) {
    await backup(this.db, file);
  }

  // Never reuse an id: other phones may still hold queued taps for a deleted game or player,
  // and those must not land on a new one that got the same id.
  nextId(table) {
    const key = `last_id_${table}`;
    const max = this.db.prepare(`SELECT COALESCE(MAX(id), 0) AS n FROM ${table}`).get().n;
    const id = Math.max(max, Number(this.meta(key) || 0)) + 1;
    this.q('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(id));
    return id;
  }

  // Sum of taps per player: Map(player_id -> {g, a, pm}). Optional game filter.
  totals(gameId = null) {
    const rows = this.q(`
      SELECT player_id,
             SUM(CASE WHEN stat = 'g'  THEN delta ELSE 0 END) AS g,
             SUM(CASE WHEN stat = 'a'  THEN delta ELSE 0 END) AS a,
             SUM(CASE WHEN stat = 'pm' THEN delta ELSE 0 END) AS pm,
             SUM(CASE WHEN stat = 's'  THEN delta ELSE 0 END) AS s
      FROM stat_events
      WHERE player_id IS NOT NULL AND (?1 IS NULL OR game_id = ?1)
      GROUP BY player_id`).all(gameId);
    return new Map(rows.map((r) => [r.player_id, { g: r.g, a: r.a, pm: r.pm, s: r.s }]));
  }

  // ----- players -----

  listPlayers() {
    return this.q(`SELECT p.id, p.name, p.number, p.active, ${LAST_POSITION} AS last_position FROM players p`).all()
      .map((p) => ({ ...p, active: !!p.active }))
      .sort((a, b) => (b.active - a.active) || byNumber(a, b));
  }

  getPlayerRow(id) {
    const p = this.q('SELECT id, name, number, active FROM players WHERE id = ?').get(id);
    if (!p) throw notFound('Player');
    return p;
  }

  createPlayer(body) {
    const name = cleanText(body.name, 'Name', 40);
    const number = cleanNumber(body.number);
    const id = this.tx(() => {
      const newId = this.nextId('players');
      this.q('INSERT INTO players (id, name, number) VALUES (?, ?, ?)').run(newId, name, number);
      return newId;
    });
    return this.getPlayerRow(id);
  }

  updatePlayer(id, body) {
    const p = this.getPlayerRow(id);
    const name = body.name !== undefined ? cleanText(body.name, 'Name', 40) : p.name;
    const number = body.number !== undefined ? cleanNumber(body.number) : p.number;
    const active = body.active !== undefined ? (body.active ? 1 : 0) : p.active;
    this.q('UPDATE players SET name = ?, number = ?, active = ? WHERE id = ?')
      .run(name, number, active, id);
    return this.getPlayerRow(id);
  }

  // Players with any history are hidden (active = 0) so old stats stay intact.
  removePlayer(id) {
    this.getPlayerRow(id);
    const used = this.q(`
      SELECT 1 FROM game_players WHERE player_id = ?1
      UNION ALL SELECT 1 FROM stat_events WHERE player_id = ?1
      LIMIT 1`).get(id);
    if (used) {
      this.q('UPDATE players SET active = 0 WHERE id = ?').run(id);
      return { removed: 'hidden' };
    }
    this.q('DELETE FROM players WHERE id = ?').run(id);
    return { removed: 'deleted' };
  }

  checkPlayersExist(ids) {
    if (!ids.length) return;
    const rows = this.db.prepare(`SELECT id FROM players WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
    if (rows.length !== ids.length) throw bad('Unknown player');
  }

  // ----- games -----

  listGames() {
    const games = this.q(`
      SELECT g.id, g.date, g.opponent, ${SCORE_COLS},
             -- "active" = created or tapped in the last 3 hours (on a doubleheader day the morning game isn't live)
             (COALESCE((SELECT MAX(e.created_at) FROM stat_events e WHERE e.game_id = g.id), g.created_at)
                >= datetime('now', '-3 hours') OR g.created_at >= datetime('now', '-3 hours')) AS active
      FROM games g
      ORDER BY g.date DESC, g.id DESC`).all().map((g) => ({ ...g, played: !!g.played, active: !!g.active }));
    const opponents = this.q('SELECT DISTINCT opponent FROM games ORDER BY opponent COLLATE NOCASE').all().map((r) => r.opponent);
    return { games, opponents };
  }

  getGameRow(id) {
    const g = this.q('SELECT id, date, opponent FROM games WHERE id = ?').get(id);
    if (!g) throw notFound('Game');
    return g;
  }

  // deviceId: the asking phone, so we can warn when another phone is tapping the same game.
  getGame(id, deviceId = null) {
    const game = this.getGameRow(id);
    const score = this.q(`SELECT ${SCORE_COLS} FROM games g WHERE g.id = ?`).get(id);
    const lineup = this.q('SELECT player_id, position FROM game_players WHERE game_id = ?').all(id);
    const dressed = lineup.map((r) => r.player_id);
    const posById = new Map(lineup.map((r) => [r.player_id, r.position]));
    const totals = this.totals(id);
    const inGame = new Set([...dressed, ...totals.keys()]);
    const players = this.q('SELECT id, name, number, active FROM players').all()
      .filter((p) => inGame.has(p.id))
      .map((p) => statRow(p, totals.get(p.id), 0, { position: posById.get(p.id) ?? null }))
      .sort(byNumber);
    const others = this.q(`
      SELECT COUNT(DISTINCT device_id) AS n FROM stat_events
      WHERE game_id = ? AND device_id IS NOT NULL AND device_id IS NOT ?
        AND created_at >= datetime('now', '-3 minutes')`).get(id, cleanToken(deviceId)).n;
    return {
      game,
      score: { us: score.us, them: score.them },
      played: !!score.played,
      // Anything entered for this game at all / any shots? The board shows – until then.
      tracked: this.q(`SELECT EXISTS (SELECT 1 FROM stat_events WHERE game_id = ?1) AS any,
                              EXISTS (SELECT 1 FROM stat_events WHERE game_id = ?1 AND stat = 's') AS s`).get(id),
      dressed,
      stats: players,
      other_phones: others,
    };
  }

  createGame(body) {
    const date = cleanDate(body.date);
    const opponent = cleanOpponent(body.opponent);
    const ids = body.player_ids === undefined
      ? this.q('SELECT id FROM players WHERE active = 1').all().map((r) => r.id)
      : cleanIds(body.player_ids);
    this.checkPlayersExist(ids);
    // Positions sent by the phone; anyone without one starts at the position they played last game.
    const given = body.positions === undefined ? null : cleanPositions(body.positions, new Set(ids));
    const last = new Map(this.listPlayers().map((p) => [p.id, p.last_position]));
    return this.tx(() => {
      const id = this.nextId('games');
      this.q('INSERT INTO games (id, date, opponent) VALUES (?, ?, ?)').run(id, date, opponent);
      const ins = this.q('INSERT OR IGNORE INTO game_players (game_id, player_id, position) VALUES (?, ?, ?)');
      for (const pid of ids) ins.run(id, pid, given ? (given[pid] ?? null) : (last.get(pid) ?? null));
      return id;
    });
  }

  updateGame(id, body, deviceId = null) {
    const g = this.getGameRow(id);
    const date = body.date !== undefined ? cleanDate(body.date) : g.date;
    const opponent = body.opponent !== undefined ? cleanOpponent(body.opponent) : g.opponent;
    const ids = body.player_ids !== undefined ? cleanIds(body.player_ids) : null;
    if (ids) this.checkPlayersExist(ids);
    const given = body.positions === undefined ? null : cleanPositions(body.positions, new Set(ids || []));
    this.tx(() => {
      this.q('UPDATE games SET date = ?, opponent = ? WHERE id = ?').run(date, opponent, id);
      if (ids) {
        const before = new Map(this.q('SELECT player_id, position FROM game_players WHERE game_id = ?').all(id)
          .map((r) => [r.player_id, r.position]));
        const posFor = (pid) => (given ? (given[pid] ?? null) : (before.get(pid) ?? null));
        this.q('DELETE FROM game_players WHERE game_id = ?').run(id);
        const ins = this.q('INSERT OR IGNORE INTO game_players (game_id, player_id, position) VALUES (?, ?, ?)');
        for (const pid of ids) ins.run(id, pid, posFor(pid));
        // Anyone with stats in this game obviously played (a tap that was undone doesn't count).
        const withStats = this.q(`SELECT DISTINCT player_id FROM (
                SELECT player_id FROM stat_events WHERE game_id = ? AND player_id IS NOT NULL
                GROUP BY player_id, stat HAVING SUM(delta) <> 0)`).all(id);
        for (const r of withStats) ins.run(id, r.player_id, before.get(r.player_id) ?? null);
      }
    });
    return this.getGame(id, deviceId);
  }

  // Change one player's position for one game (from the tap board). Adds them to the lineup if needed.
  setGamePosition(gameId, playerId, body, deviceId = null) {
    this.getGameRow(gameId);
    this.getPlayerRow(playerId);
    const position = cleanPosition(body.position);
    this.q(`INSERT INTO game_players (game_id, player_id, position) VALUES (?, ?, ?)
            ON CONFLICT (game_id, player_id) DO UPDATE SET position = excluded.position`).run(gameId, playerId, position);
    return this.getGame(gameId, deviceId);
  }

  deleteGame(id) {
    this.getGameRow(id);
    this.q('DELETE FROM games WHERE id = ?').run(id);
    return { deleted: true };
  }

  // ----- taps -----

  // taps: [{client_id, player_id, stat, delta}] in the order they were tapped.
  // Safe to resend: a client_id already stored is skipped. Goals/assists/their score never go below 0.
  addTaps(gameId, taps, deviceId = null) {
    this.getGameRow(gameId);
    if (!Array.isArray(taps) || taps.length > 500) throw bad('Expected a list of taps');
    const clean = taps.map((t) => {
      if (!t || typeof t !== 'object') throw bad('Bad tap');
      const stat = t.stat;
      if (!STATS.includes(stat)) throw bad('stat must be g, a, pm, s or opp');
      const delta = Number(t.delta);
      if (delta !== 1 && delta !== -1) throw bad('delta must be 1 or -1');
      const playerId = stat === 'opp' ? null : cleanId(t.player_id, 'player');
      if (stat !== 'opp' && !playerId) throw bad('Which player?');
      return { clientId: cleanToken(t.client_id), playerId, stat, delta };
    });
    this.checkPlayersExist([...new Set(clean.map((t) => t.playerId).filter(Boolean))]);
    const device = cleanToken(deviceId);
    let applied = 0;
    this.tx(() => {
      const seen = this.q('SELECT 1 FROM stat_events WHERE client_id = ?');
      const sum = this.q(`SELECT COALESCE(SUM(delta), 0) AS n FROM stat_events
                          WHERE game_id = ? AND stat = ? AND player_id IS ?`);
      const ins = this.q(`INSERT INTO stat_events (game_id, player_id, stat, delta, client_id, device_id)
                          VALUES (?, ?, ?, ?, ?, ?)`);
      // A late arrival tapped in during the game starts at the position they played last game.
      const dress = this.q(`INSERT OR IGNORE INTO game_players (game_id, player_id, position)
                            SELECT ?1, p.id, ${LAST_POSITION} FROM players p WHERE p.id = ?2`);
      for (const t of clean) {
        if (t.clientId && seen.get(t.clientId)) continue;
        if (t.delta < 0 && NEVER_NEGATIVE.has(t.stat) && sum.get(gameId, t.stat, t.playerId).n <= 0) continue;
        ins.run(gameId, t.playerId, t.stat, t.delta, t.clientId, device);
        if (t.playerId) dress.run(gameId, t.playerId);
        applied++;
      }
    });
    return { applied, game: this.getGame(gameId, device) };
  }

  // ----- season / player stats -----

  seasonStats() {
    const { games } = this.listGames();
    const played = games.filter((g) => g.played);
    const gp = new Map(this.q(`
      SELECT gp.player_id, COUNT(*) AS n FROM game_players gp JOIN games g ON g.id = gp.game_id
      WHERE EXISTS (SELECT 1 FROM stat_events e WHERE e.game_id = g.id) OR g.date < date('now', '-1 day')
      GROUP BY gp.player_id`).all().map((r) => [r.player_id, r.n]));
    // Positions played this season, most played first (e.g. ['C', 'W']).
    const positions = new Map();
    for (const r of this.q(`
      SELECT gp.player_id, gp.position, COUNT(*) AS n FROM game_players gp JOIN games g ON g.id = gp.game_id
      WHERE gp.position IS NOT NULL
        AND (EXISTS (SELECT 1 FROM stat_events e WHERE e.game_id = g.id) OR g.date < date('now', '-1 day'))
      GROUP BY gp.player_id, gp.position ORDER BY n DESC, gp.position`).all()) {
      if (!positions.has(r.player_id)) positions.set(r.player_id, []);
      positions.get(r.player_id).push(r.position);
    }
    // "–" instead of 0 when nothing was entered: a player's G/A/+/− count once any of their games has
    // stats entered; shots count once any of their games had shots tracked.
    const gameFlags = new Map(this.q(`SELECT game_id, MAX(stat = 's') AS s FROM stat_events GROUP BY game_id`).all()
      .map((r) => [r.game_id, { s: !!r.s }]));
    const gamesOf = new Map();
    const addGame = (pid, gid) => {
      if (!gamesOf.has(pid)) gamesOf.set(pid, new Set());
      gamesOf.get(pid).add(gid);
    };
    for (const r of this.q('SELECT player_id, game_id FROM game_players').all()) addGame(r.player_id, r.game_id);
    for (const r of this.q('SELECT DISTINCT player_id, game_id FROM stat_events WHERE player_id IS NOT NULL').all()) addGame(r.player_id, r.game_id);
    const totals = this.totals();
    const players = this.q('SELECT id, name, number, active FROM players').all()
      .filter((p) => p.active || totals.has(p.id) || gp.has(p.id))
      .map((p) => {
        const mine = [...(gamesOf.get(p.id) || [])];
        const tracked = mine.some((gid) => gameFlags.has(gid));
        const shots = mine.some((gid) => gameFlags.get(gid)?.s);
        const t = totals.get(p.id) || { g: 0, a: 0, pm: 0, s: 0 };
        const vals = tracked ? { g: t.g, a: t.a, pm: t.pm } : { g: null, a: null, pm: null };
        return statRow(p, { ...vals, s: shots ? t.s : null }, gp.get(p.id) || 0, { positions: positions.get(p.id) || [] });
      });
    const record = { w: 0, l: 0, t: 0 };
    for (const g of played) record[g.us > g.them ? 'w' : g.us < g.them ? 'l' : 't']++;
    return {
      games: played.length,
      record,
      goals_for: played.reduce((n, g) => n + g.us, 0),
      goals_against: played.reduce((n, g) => n + g.them, 0),
      players,
    };
  }

  playerDetail(id) {
    const p = this.getPlayerRow(id);
    const games = this.q(`
      SELECT g.id, g.date, g.opponent, ${SCORE_COLS},
             EXISTS (SELECT 1 FROM game_players gp WHERE gp.game_id = g.id AND gp.player_id = ?1) AS dressed,
             (SELECT gp.position FROM game_players gp WHERE gp.game_id = g.id AND gp.player_id = ?1) AS position,
             (SELECT COALESCE(SUM(delta), 0) FROM stat_events e WHERE e.game_id = g.id AND e.player_id = ?1 AND e.stat = 'g')  AS pg,
             (SELECT COALESCE(SUM(delta), 0) FROM stat_events e WHERE e.game_id = g.id AND e.player_id = ?1 AND e.stat = 'a')  AS pa,
             (SELECT COALESCE(SUM(delta), 0) FROM stat_events e WHERE e.game_id = g.id AND e.player_id = ?1 AND e.stat = 'pm') AS ppm,
             (SELECT COALESCE(SUM(delta), 0) FROM stat_events e WHERE e.game_id = g.id AND e.player_id = ?1 AND e.stat = 's')  AS ps,
             EXISTS (SELECT 1 FROM stat_events e WHERE e.game_id = g.id) AS has_stats,
             EXISTS (SELECT 1 FROM stat_events e WHERE e.game_id = g.id AND e.stat = 's') AS has_shots
      FROM games g
      WHERE EXISTS (SELECT 1 FROM game_players gp WHERE gp.game_id = g.id AND gp.player_id = ?1)
         OR EXISTS (SELECT 1 FROM stat_events e WHERE e.game_id = g.id AND e.player_id = ?1)
      ORDER BY g.date DESC, g.id DESC`).all(id);
    // Per game: – (null) when nothing was entered for that game; shots – when shots weren't tracked.
    const perGame = games.map((g) => ({
      game_id: g.id, date: g.date, opponent: g.opponent, us: g.us, them: g.them, played: !!g.played, position: g.position,
      g: g.has_stats ? g.pg : null,
      a: g.has_stats ? g.pa : null,
      pts: g.has_stats ? g.pg + g.pa : null,
      pm: g.has_stats ? g.ppm : null,
      s: g.has_shots ? g.ps : null,
    }));
    const sum = (k) => {
      const vals = perGame.map((g) => g[k]).filter((x) => x !== null);
      return vals.length ? vals.reduce((n, x) => n + x, 0) : null;
    };
    const gp = games.filter((g) => g.dressed && g.played).length;
    const totals = statRow(p, { g: sum('g'), a: sum('a'), pm: sum('pm'), s: sum('s') }, gp);
    return { player: { ...p, active: !!p.active }, totals, games: perGame };
  }
}

// The starting roster is not in the code (kids' names don't belong in a public repo). A brand-new
// database is seeded from roster.json (gitignored): [["First Last", 87], ...]. Skaters only.
function loadRoster(file) {
  if (!file || !fs.existsSync(file)) return [];
  const list = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(list)) throw new Error(`${file} must be a list of ["Name", number]`);
  return list.map(([name, number]) => [cleanText(name, 'Name', 40), cleanNumber(number)]);
}

function openDb(file, { roster = [] } = {}) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  const store = new Store(db);
  const version = db.prepare('PRAGMA user_version').get().user_version;
  for (let v = version; v < MIGRATIONS.length; v++) {
    store.tx(() => {
      MIGRATIONS[v](db);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
  // Random per-install secret for signing the team-code cookie (lives on the volume with the data).
  store.q("INSERT OR IGNORE INTO meta (key, value) VALUES ('secret', ?)").run(crypto.randomBytes(32).toString('hex'));
  if (!store.meta('seeded')) {
    store.tx(() => {
      if (store.q('SELECT COUNT(*) AS n FROM players').get().n === 0) {
        const ins = store.q('INSERT INTO players (name, number) VALUES (?, ?)');
        for (const [name, number] of roster) ins.run(name, number);
      }
      store.q("INSERT INTO meta (key, value) VALUES ('seeded', datetime('now'))").run();
    });
  }
  return store;
}

module.exports = { openDb, loadRoster, HttpError, cleanDate, POSITIONS };
