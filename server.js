'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { openDb, loadRoster, HttpError, POSITIONS } = require('./db');

const COOKIE = 'team_auth';
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      out[k] = '';
    }
  }
  return out;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s) && !/^[+-]?\d+$/.test(s) && s !== '-') s = `'${s}`; // no spreadsheet formulas
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function createApp({ dbPath, teamCode = '', teamName = 'Our Team', secure = false, roster = [] } = {}) {
  const store = openDb(dbPath, { roster });
  const code = String(teamCode).trim().toLowerCase();
  // Keyed with a secret stored in the DB, so the cookie can't be computed from a guessed code
  // (the only way to test a code is /api/login, which is rate-limited).
  const token = code ? crypto.createHmac('sha256', store.meta('secret')).update(`team-stats:v1:${code}`).digest('hex') : null;
  const isAuthed = (req) => !token || safeEqual(parseCookies(req.headers.cookie)[COOKIE] || '', token);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex, nofollow',
      'Content-Security-Policy': [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src https://fonts.gstatic.com",
        "img-src 'self' data:",
        "connect-src 'self'",
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "form-action 'self'",
      ].join('; '),
    });
    next();
  });

  app.get('/healthz', (req, res) => res.type('text').send('ok'));
  app.get('/robots.txt', (req, res) => res.type('text').send('User-agent: *\nDisallow: /\n'));

  app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders: (res) => res.set('Cache-Control', 'no-cache'),
  }));

  // ----- API -----
  const api = express.Router();
  api.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  api.use(express.json({ limit: '64kb' }));

  api.get('/config', (req, res) => res.json({ teamName, needsCode: !!token, authed: isAuthed(req) }));

  // Tiny brute-force guard for the team code.
  const attempts = new Map();
  api.post('/login', (req, res) => {
    const ip = req.get('fly-client-ip') || req.ip || 'x';
    const now = Date.now();
    if (attempts.size > 1000) for (const [k, v] of attempts) if (now > v.reset) attempts.delete(k);
    const a = attempts.get(ip) || { n: 0, reset: now + 10 * 60 * 1000 };
    if (now > a.reset) Object.assign(a, { n: 0, reset: now + 10 * 60 * 1000 });
    if (a.n >= 20) return res.status(429).json({ error: 'Too many tries. Wait 10 minutes and try again.' });
    if (!token) return res.json({ ok: true });
    const given = String(req.body?.code ?? '').trim().toLowerCase();
    if (!given || !safeEqual(given, code)) {
      a.n++;
      attempts.set(ip, a);
      return res.status(401).json({ error: 'Wrong code. Ask your team manager.' });
    }
    attempts.delete(ip);
    res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure, maxAge: ONE_YEAR_MS, path: '/' });
    res.json({ ok: true });
  });

  api.use((req, res, next) => (isAuthed(req) ? next() : res.status(401).json({ error: 'Enter the team code first.' })));

  // Writes must be JSON (blocks cross-site form posts; DELETE can't come from a form).
  api.use((req, res, next) => {
    if ((req.method === 'POST' || req.method === 'PUT') && !req.is('application/json')) {
      return res.status(415).json({ error: 'Send JSON' });
    }
    next();
  });

  const id = (req, name = 'id') => {
    const n = Number(req.params[name]);
    if (!Number.isSafeInteger(n) || n <= 0) throw new HttpError(404, 'Not found');
    return n;
  };
  const body = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});

  api.get('/players', (req, res) => res.json({ players: store.listPlayers() }));
  api.post('/players', (req, res) => res.status(201).json({ player: store.createPlayer(body(req)) }));
  api.get('/players/:id', (req, res) => res.json(store.playerDetail(id(req))));
  api.put('/players/:id', (req, res) => res.json({ player: store.updatePlayer(id(req), body(req)) }));
  api.delete('/players/:id', (req, res) => res.json(store.removePlayer(id(req))));

  // Each phone sends a random id so the game screen can warn when two phones tap the same game.
  const device = (req) => req.get('x-device-id') || null;

  api.get('/games', (req, res) => res.json(store.listGames()));
  api.post('/games', (req, res) => res.status(201).json(store.getGame(store.createGame(body(req)), device(req))));
  api.get('/games/:id', (req, res) => res.json(store.getGame(id(req), device(req))));
  api.put('/games/:id', (req, res) => res.json(store.updateGame(id(req), body(req), device(req))));
  api.delete('/games/:id', (req, res) => res.json(store.deleteGame(id(req))));
  // Change one player's position for one game (C, W or D).
  api.put('/games/:id/players/:pid', (req, res) => res.json(store.setGamePosition(id(req), id(req, 'pid'), body(req), device(req))));

  // Live entry: a batch of + / − taps, in order. Safe to resend (each tap has a unique client_id).
  api.post('/games/:id/taps', (req, res) => res.json(store.addTaps(id(req), body(req).taps, device(req))));

  api.get('/stats', (req, res) => res.json(store.seasonStats()));

  api.get('/stats.csv', (req, res) => {
    const s = store.seasonStats();
    // "-" = nothing entered (not the same as 0).
    const cell = (v) => (v === null ? '-' : v);
    const rows = [['Number', 'Player', 'Positions played', 'Games', 'Goals', 'Assists', 'Points', 'Plus/Minus', 'Shots on goal']];
    for (const p of s.players.sort((a, b) => (b.pts ?? -1) - (a.pts ?? -1) || (b.g ?? -1) - (a.g ?? -1) || (b.pm ?? 0) - (a.pm ?? 0))) {
      rows.push([p.number ?? '', p.name, p.positions.map((x) => POSITIONS[x]).join('/'), p.gp,
        cell(p.g), cell(p.a), cell(p.pts), cell(p.pm), cell(p.s)]);
    }
    res.set('Content-Disposition', 'attachment; filename="season-stats.csv"');
    res.type('text/csv').send(rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n');
  });

  api.get('/backup', async (req, res, next) => {
    const tmp = path.join(os.tmpdir(), `team-stats-backup-${process.pid}-${Date.now()}.db`);
    try {
      await store.backupTo(tmp);
      res.download(tmp, `team-stats-${new Date().toISOString().slice(0, 10)}.db`, () => fs.rm(tmp, { force: true }, () => {}));
    } catch (e) {
      fs.rm(tmp, { force: true }, () => {});
      next(e);
    }
  });

  api.use((req, res) => res.status(404).json({ error: 'Not found' }));

  app.use('/api', api);

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Bad JSON' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Too much data' });
    if (Number.isInteger(err.status) && err.status >= 400 && err.status < 500) {
      return res.status(err.status).json({ error: 'Bad request' });
    }
    console.error(err);
    res.status(500).json({ error: 'Server error. Try again.' });
  });

  app.store = store;
  return app;
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const app = createApp({
    dbPath: process.env.DB_PATH || path.join(__dirname, 'data', 'stats.db'),
    teamCode: process.env.TEAM_CODE || '',
    teamName: process.env.TEAM_NAME || '12U A Green',
    secure: process.env.NODE_ENV === 'production',
    roster: loadRoster(process.env.ROSTER_FILE || path.join(__dirname, 'roster.json')),
  });
  if (!process.env.TEAM_CODE) console.warn('WARNING: TEAM_CODE is not set - anyone with the link can see and change stats.');
  const server = app.listen(port, () => console.log(`Team stats listening on :${port}`));
  const stop = () => {
    server.close(() => {
      app.store.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

module.exports = { createApp };
