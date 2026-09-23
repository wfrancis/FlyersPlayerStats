'use strict';
(() => {
  const $app = document.getElementById('app');
  const $sheet = document.getElementById('sheet');
  const $toast = document.getElementById('toast');
  const QUEUE_KEY = 'teamStats.pendingTaps.v1';
  const CACHE_KEY = 'teamStats.cache.v1';
  const POS = { C: 'Center', W: 'Wing', D: 'Defense' };
  const DEVICE_KEY = 'teamStats.device.v1';

  const S = {
    config: { teamName: 'Our Team', needsCode: false, authed: true },
    players: [],
    pmap: new Map(),
    game: null, // detail of the game on screen
    statsById: new Map(), // player id -> server totals for the game on screen
    layoutSig: '',
    showAll: false,
    showAllGames: false, // home page: all games instead of the most recent few
    games: [], // the games list on the home page
    extraShown: new Set(), // players drawn under "Not in today's lineup" stay there while the board is open
    poll: null,
    form: null, // new/edit game form state
    stats: null,
    statsSort: { key: 'pts', dir: -1 },
    seq: 0, // bumps on every navigation so slow responses can't paint over a newer page
    sheetPushed: false,
    skipPop: false,
    toastTimer: null,
    toastFn: null,
    pendingToast: null, // shown after the next page change (a page change hides toasts)
    // Taps are saved on the phone first, then sent in the background. Survives no signal and reloads.
    queue: loadQueue(), // [{ gameId, payload: { client_id, player_id, stat, delta } }]
    flushing: false,
    offline: false,
    undo: [], // this phone's taps on the game on screen, newest last
    lastTap: null,
    lastUndoAt: 0,
    posPending: new Map(), // player id -> position just tapped on the board, until the server confirms
    posChain: Promise.resolve(), // position changes are sent one at a time, in order
    wakeLock: null,
  };
  const DEVICE = deviceId();

  // ---------- helpers ----------

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
  const P = (id) => S.pmap.get(id);
  const byNum = (a, b) => (a.number ?? 999) - (b.number ?? 999) || a.name.localeCompare(b.name);

  function splitName(name) {
    const s = String(name || '').trim();
    const i = s.indexOf(' ');
    return i < 0 ? ['', s] : [s.slice(0, i), s.slice(i + 1)];
  }
  const numOf = (p) => ((p.number ?? '') === '' ? '–' : String(p.number));
  function shortName(id) {
    const p = P(id);
    if (!p) return 'player';
    return p.number != null ? `#${p.number} ${splitName(p.name)[1]}` : splitName(p.name)[1];
  }

  function parseISO(s) {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  function fmtDate(s, long) {
    const d = parseISO(s);
    const opts = long
      ? { weekday: 'long', month: 'long', day: 'numeric' }
      : { weekday: 'short', month: 'short', day: 'numeric' };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
    return d.toLocaleDateString(undefined, opts);
  }
  function todayISO() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  const fmtPM = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0');
  const pmCls = (n) => (n > 0 ? 'pos' : n < 0 ? 'neg' : 'zero');
  const resultOf = (us, them) => (us > them ? 'W' : us < them ? 'L' : 'T');
  const toId = (s) => {
    const n = Number(s);
    return Number.isSafeInteger(n) && n > 0 ? n : 0;
  };
  // "C/W" for a season row (positions played, most first), "Center" for a single game.
  const posText = (r) => (r.positions?.length ? r.positions.join('/') : POS[r.position] || '');
  const withPos = (first, r) => (posText(r) ? `${first} · ${posText(r)}` : first);

  // Last good copy of the roster / games / each game, so the board opens even with no signal.
  function cacheGet(key) {
    try {
      return JSON.parse(localStorage.getItem(`${CACHE_KEY}.${key}`) || 'null');
    } catch {
      return null;
    }
  }
  function cachePut(key, value) {
    try {
      localStorage.setItem(`${CACHE_KEY}.${key}`, JSON.stringify(value));
    } catch {
      /* storage full or blocked */
    }
  }
  async function fetchOrCache(url, key) {
    try {
      const data = await api('GET', url);
      cachePut(key, data);
      return { data, cached: false };
    } catch (e) {
      const data = e.network ? cacheGet(key) : null;
      if (!data) throw e;
      return { data, cached: true };
    }
  }

  const haptic = () => {
    try {
      navigator.vibrate?.(25);
    } catch {
      /* not supported */
    }
  };
  function randomId() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
  }
  function deviceId() {
    try {
      let id = localStorage.getItem(DEVICE_KEY);
      if (!id) localStorage.setItem(DEVICE_KEY, (id = randomId()));
      return id;
    } catch {
      return randomId();
    }
  }

  async function api(method, url, body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000); // rink wifi can hang forever; give up and retry
    const opt = {
      method,
      headers: { Accept: 'application/json', 'X-Device-Id': DEVICE },
      credentials: 'same-origin',
      signal: ctrl.signal,
    };
    if (body !== undefined) {
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }
    let res;
    let data = {};
    try {
      res = await fetch(url, opt);
      try {
        data = await res.json();
      } catch {
        /* empty or non-JSON body */
      }
    } catch {
      const e = new Error("No signal — couldn't reach the server. Try again.");
      e.network = true;
      throw e;
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401 && url !== '/api/login') {
      S.config.authed = false;
      if (!document.body.classList.contains('locked')) showLogin();
      const e = new Error(data.error || 'Enter the team code first.');
      e.silent = true;
      throw e;
    }
    if (!res.ok) {
      const e = new Error(data.error || `Something went wrong (${res.status}). Try again.`);
      e.network = res.status >= 500 || res.status === 429; // server hiccup: keep taps queued and retry
      throw e;
    }
    return data;
  }

  async function loadPlayers() {
    const { data: { players } } = await fetchOrCache('/api/players', 'players');
    S.players = players;
    S.pmap = new Map(players.map((p) => [p.id, p]));
  }

  const current = (seq) => seq === S.seq;
  function paint(seq, html) {
    if (!current(seq)) return false;
    $app.innerHTML = html;
    window.scrollTo(0, 0);
    return true;
  }

  function formError(msg, focusEl) {
    const box = ($sheet.hidden ? $app : $sheet).querySelector('#form-error');
    if (box) box.innerHTML = msg ? `<div class="error-box">${esc(msg)}</div>` : '';
    if (focusEl) focusEl.focus();
  }

  function toast(msg, actionLabel, actionFn) {
    clearTimeout(S.toastTimer);
    $toast.innerHTML = `<span>${esc(msg)}</span>${actionLabel ? `<button type="button" data-action="toast-action">${esc(actionLabel)}</button>` : ''}`;
    S.toastFn = actionFn || null;
    $toast.hidden = false;
    S.toastTimer = setTimeout(hideToast, actionFn ? 6000 : 3000);
  }
  function hideToast() {
    $toast.hidden = true;
    S.toastFn = null;
  }

  // ---------- keep the screen on during a game ----------

  async function keepAwake(on) {
    try {
      if (on && !S.wakeLock && 'wakeLock' in navigator && document.visibilityState === 'visible') {
        S.wakeLock = await navigator.wakeLock.request('screen');
        S.wakeLock.addEventListener('release', () => {
          S.wakeLock = null;
        });
      } else if (!on && S.wakeLock) {
        const lock = S.wakeLock;
        S.wakeLock = null;
        await lock.release();
      }
    } catch {
      /* not supported / not allowed — the phone just locks normally */
    }
  }

  // ---------- tap queue (saved on the phone first, sent when there's signal) ----------

  function loadQueue() {
    try {
      const q = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
      return Array.isArray(q) ? q.filter((x) => x && x.gameId && x.payload && x.payload.client_id) : [];
    } catch {
      return [];
    }
  }
  function saveQueue() {
    try {
      localStorage.setItem(QUEUE_KEY, JSON.stringify(S.queue));
    } catch {
      /* private browsing: the queue still works while this page stays open */
    }
  }

  async function flushQueue() {
    if (S.flushing || !S.queue.length || (S.config.needsCode && !S.config.authed)) return;
    S.flushing = true;
    try {
      while (S.queue.length) {
        const gameId = S.queue[0].gameId;
        const batch = S.queue.filter((x) => x.gameId === gameId).slice(0, 200);
        const ids = new Set(batch.map((x) => x.payload.client_id));
        // From here on the server may have these taps even if we never hear back — Undo must send an opposite tap.
        for (const x of batch) x.sent = true;
        saveQueue();
        let res;
        try {
          res = await api('POST', `/api/games/${gameId}/taps`, { taps: batch.map((x) => x.payload) });
        } catch (e) {
          if (e.silent) break; // needs the team code first
          if (e.network) {
            S.offline = true;
            break;
          }
          // Rejected (e.g. the game was deleted on another phone): drop these so the rest can go.
          S.queue = S.queue.filter((x) => !ids.has(x.payload.client_id));
          saveQueue();
          toast(`Some taps couldn't be saved: ${e.message}`);
          continue;
        }
        S.offline = false;
        S.queue = S.queue.filter((x) => !ids.has(x.payload.client_id));
        saveQueue();
        applyGame(res.game);
      }
    } finally {
      S.flushing = false;
      paintLive();
    }
  }
  setInterval(flushQueue, 4000);
  window.addEventListener('online', flushQueue);

  // ---------- sheet (full-screen overlay, used for the player editor) ----------
  // Opening pushes a history entry so the phone's Back button closes the sheet instead of leaving the page.

  function openSheet() {
    hideToast();
    if (!S.sheetPushed) {
      history.pushState({ sheet: 1 }, '');
      S.sheetPushed = true;
    }
    $sheet.hidden = false;
    document.body.classList.add('sheet-open');
  }
  function closeSheet({ fromPop = false, navigating = false } = {}) {
    $sheet.hidden = true;
    $sheet.innerHTML = '';
    document.body.classList.remove('sheet-open');
    if (S.sheetPushed) {
      S.sheetPushed = false;
      if (!fromPop && !navigating) {
        S.skipPop = true;
        history.back();
      }
    }
  }
  window.addEventListener('popstate', () => {
    if (S.skipPop) {
      S.skipPop = false;
      return;
    }
    if (!$sheet.hidden) closeSheet({ fromPop: true });
  });

  // ---------- router ----------

  function setTab(name) {
    document.querySelectorAll('#tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.tab === name));
  }

  async function route() {
    const seq = ++S.seq;
    stopPoll();
    keepAwake(false);
    closeSheet({ navigating: true });
    if (!S.toastFn) hideToast();
    if (S.pendingToast) {
      toast(S.pendingToast);
      S.pendingToast = null;
    }
    document.body.classList.remove('locked');
    if (S.config.needsCode && !S.config.authed) return showLogin();
    const [a, b, c] = location.hash.replace(/^#\/?/, '').split('/');
    setTab(a === 'stats' || a === 'player' ? 'stats' : a === 'roster' ? 'roster' : 'games');
    try {
      if (!a) await viewGames(seq);
      else if (a === 'new') await viewGameForm(seq, 0);
      else if (a === 'game' && c === 'edit') await viewGameForm(seq, toId(b));
      else if (a === 'game') await viewGame(seq, toId(b));
      else if (a === 'stats') await viewStats(seq);
      else if (a === 'player') await viewPlayer(seq, toId(b));
      else if (a === 'roster') await viewRoster(seq);
      else location.replace('#/');
    } catch (e) {
      if (e.silent || !current(seq)) return;
      $app.innerHTML = `
        <div class="error-box">${esc(e.message)}</div>
        <button class="btn btn-light mt" data-action="retry">Try again</button>
        <div class="center mt"><a class="btn-text" href="#/">Back to games</a></div>`;
    }
  }

  // ---------- login ----------

  function showLogin() {
    S.seq++;
    stopPoll();
    closeSheet({ navigating: true });
    setTab('');
    document.body.classList.add('locked');
    $app.innerHTML = `
      <form class="login card" data-form="login" novalidate>
        <h1>Team code</h1>
        <p>Ask your team manager for the code.<br>You only need to do this once on this phone.</p>
        <input class="input" name="code" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" enterkeyhint="go" placeholder="Code" aria-label="Team code">
        <div id="form-error"></div>
        <button class="btn btn-green" type="submit">Go</button>
      </form>`;
    $app.querySelector('input').focus();
  }

  async function submitLogin(form) {
    const code = form.code.value.trim();
    if (!code) return formError('Type the team code.', form.code);
    try {
      await api('POST', '/api/login', { code });
      S.config.authed = true;
      route();
      flushQueue();
    } catch (e) {
      formError(e.message, form.code);
      form.code.select();
    }
  }

  // ---------- games list ----------

  const RECENT_GAMES = 5;

  async function viewGames(seq) {
    // Season totals load alongside but never hold up (or break) the games list — that's how parents get into today's game.
    const statsP = fetchOrCache('/api/stats', 'stats').catch((error) => ({ error }));
    const { data: { games }, cached } = await fetchOrCache('/api/games', 'games');
    if (!current(seq)) return;
    S.games = games;
    // On a doubleheader day the morning game is over: only a game started or tapped in the last few hours is "live".
    const live = games.find((g) => g.date === todayISO() && g.active);
    const shown = S.showAllGames ? games : games.slice(0, RECENT_GAMES);
    paint(seq, `
      ${cached ? '<div class="notice">No signal — showing the last saved list.</div>' : ''}
      ${live ? `<a class="live-card" href="#/game/${live.id}">
          <span class="live-dot" aria-hidden="true"></span>
          <span class="lc-main"><span class="lc-label">Today's game — tap to enter stats</span><span class="lc-opp">vs ${esc(live.opponent)}</span></span>
          <span class="lc-score">${live.us}–${live.them}</span>
        </a>` : ''}
      <a class="btn ${live ? 'btn-light' : 'btn-huge btn-green'}" href="#/new">＋ New game</a>
      <h2 class="section-title">Games</h2>
      ${games.length
        ? `<ul class="game-list">${shown.map(gameCard).join('')}</ul>`
        : '<div class="empty">No games yet.<br>Tap <b>New game</b> when the puck drops.</div>'}
      ${games.length > shown.length ? `<div class="center mt"><button type="button" class="btn-text" data-action="all-games">Show all ${games.length} games</button></div>` : ''}
      <h2 class="section-title">Season totals <span class="muted" id="season-count"></span></h2>
      <div id="season-note"></div>
      <div id="season-stats"><div class="loading">Loading…</div></div>`);
    const s = await statsP;
    if (current(seq)) fillSeason(s);
  }

  function fillSeason(s) {
    const box = document.getElementById('season-stats');
    if (!box) return;
    if (s.error) {
      if (s.error.silent) return;
      box.innerHTML = `<div class="error-box">Season totals didn't load. ${esc(s.error.message)}</div>
        <button type="button" class="btn btn-light" data-action="retry-season">Try again</button>`;
      return;
    }
    S.stats = s.data;
    const n = s.data.games;
    document.getElementById('season-count').textContent = `${n} game${n === 1 ? '' : 's'} played`;
    // Outside #season-stats so sorting (which redraws that box) keeps the note.
    document.getElementById('season-note').innerHTML = s.cached
      ? '<div class="notice">No signal — season totals are from the last saved copy.</div>' : '';
    box.innerHTML = renderStatsBody();
  }

  function gameCard(g) {
    const r = resultOf(g.us, g.them);
    const score = g.played
      ? `<span class="res res-${r}" aria-label="${r === 'W' ? 'Win' : r === 'L' ? 'Loss' : 'Tie'}">${r}</span>${g.us}–${g.them}`
      : '<span class="muted">0–0</span>';
    return `<li><a class="game-card" href="#/game/${g.id}">
      <div class="gc-main"><div class="gc-date">${esc(fmtDate(g.date))}</div><div class="gc-opp">vs ${esc(g.opponent)}</div></div>
      <div class="gc-score">${score}<span class="chev" aria-hidden="true">›</span></div>
    </a></li>`;
  }

  // ---------- new / edit game ----------

  async function viewGameForm(seq, id) {
    const [{ opponents }, detail] = await Promise.all([
      api('GET', '/api/games'),
      id ? api('GET', `/api/games/${id}`) : null,
      loadPlayers(),
    ]);
    if (!current(seq)) return;
    // Everyone starts where they played last game; positions are per game, so they can differ each time.
    S.form = {
      id,
      dressed: new Set(detail ? detail.dressed : S.players.filter((p) => p.active).map((p) => p.id)),
      pos: new Map(detail
        ? detail.stats.map((r) => [r.id, r.position])
        : S.players.map((p) => [p.id, p.last_position])),
      saving: false,
    };
    const pool = S.players.filter((p) => p.active || S.form.dressed.has(p.id)).sort(byNum);
    const opp = detail?.game.opponent === 'Opponent' ? '' : detail?.game.opponent ?? '';
    paint(seq, `
      <div class="topline"><a class="back" href="${id ? `#/game/${id}` : '#/'}">‹ ${id ? 'Back to game' : 'Games'}</a></div>
      <h1 class="page-title">${id ? 'Edit game' : 'New game'}</h1>
      <form data-form="game" novalidate autocomplete="off">
        <label class="field">
          <span class="field-label">Playing against <span class="muted">(optional)</span></span>
          <input class="input" name="opponent" list="opp-list" maxlength="60" placeholder="Other team's name"
            value="${esc(opp)}" autocapitalize="words" enterkeyhint="next">
        </label>
        <datalist id="opp-list">${opponents.filter((o) => o !== 'Opponent').map((o) => `<option value="${esc(o)}"></option>`).join('')}</datalist>
        <div class="field">
          <span class="field-label">Who's here, and where do they play today?</span>
          <p class="hint">Tap <b>C</b> (center), <b>W</b> (wing) or <b>D</b> (defense) — or <b>OUT</b> if they're not here.
            Everyone starts where they played last game.</p>
          <div class="lineup" id="lineup">${pool.map((p) => lineupRow(p)).join('')}</div>
          <p class="count-line" id="lineup-count"></p>
        </div>
        <label class="field">
          <span class="field-label">Date</span>
          <input class="input" type="date" name="date" value="${esc(detail?.game.date ?? todayISO())}">
        </label>
        <div id="form-error"></div>
        <div class="sticky-submit">
          <button class="btn btn-huge btn-green" type="submit">${id ? 'Save changes' : 'Start game →'}</button>
        </div>
      </form>
      ${id ? '<button type="button" class="btn btn-danger-outline mt-lg" data-action="delete-game">Delete this game</button>' : ''}`);
    updateLineupCount();
  }

  function lineupRow(p) {
    const f = S.form;
    const here = f.dressed.has(p.id);
    const pos = f.pos.get(p.id) || null;
    const [first, last] = splitName(p.name);
    const opt = (k, label) => {
      const on = k === 'OUT' ? !here : here && pos === k;
      return `<button type="button" class="lu-opt ${k === 'OUT' ? 'lu-out' : ''} ${on ? 'on' : ''}" data-action="set-lineup"
        data-id="${p.id}" data-v="${k}" aria-pressed="${on}" aria-label="${esc(p.name)}: ${label}">${k}</button>`;
    };
    return `<div class="lu-row ${here ? '' : 'is-out'}">
      <span class="num-badge">${esc(numOf(p))}</span>
      <span class="lu-name">${esc(last)}<span class="lu-first">${esc(first)}</span></span>
      <span class="lu-opts">${opt('C', 'Center')}${opt('W', 'Wing')}${opt('D', 'Defense')}${opt('OUT', 'Not here')}</span>
    </div>`;
  }

  function updateLineupCount() {
    const el = document.getElementById('lineup-count');
    if (!el) return;
    const n = S.form.dressed.size;
    const noPos = [...S.form.dressed].filter((id) => !S.form.pos.get(id)).length;
    el.textContent = `${n} player${n === 1 ? '' : 's'} playing${noPos ? ` · ${noPos} without a position` : ''}`;
  }

  async function submitGameForm(form) {
    const f = S.form;
    if (!f || f.saving) return;
    const opponent = form.opponent.value.trim();
    const date = form.date.value || todayISO();
    if (!f.dressed.size) return formError('Pick at least one player.');
    f.saving = true;
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      if (!f.id) {
        // Two parents often both tap "New game" at puck drop. Offer the game that already exists.
        const { games } = await api('GET', '/api/games');
        const same = games.find((g) => g.date === date && g.active
          && (!opponent || g.opponent === 'Opponent' || g.opponent.toLowerCase() === opponent.toLowerCase()));
        if (same && confirm(`There's already a game on this day (vs ${same.opponent}, ${same.us}–${same.them}). Someone may have started it.\n\nOK = open that game\nCancel = start a new one`)) {
          location.replace(`#/game/${same.id}`);
          return;
        }
      }
      const positions = Object.fromEntries([...f.dressed].filter((pid) => f.pos.get(pid)).map((pid) => [pid, f.pos.get(pid)]));
      const body = { opponent, date, player_ids: [...f.dressed], positions };
      const d = f.id ? await api('PUT', `/api/games/${f.id}`, body) : await api('POST', '/api/games', body);
      location.replace(`#/game/${d.game.id}`); // Back from the game shouldn't land on this form again
    } catch (e) {
      if (!e.silent) formError(e.message);
    } finally {
      f.saving = false;
      btn.disabled = false;
    }
  }

  // ---------- one game: the live tap board ----------

  async function viewGame(seq, id) {
    if (!id) throw new Error('Game not found');
    const [{ data: d, cached }] = await Promise.all([fetchOrCache(`/api/games/${id}`, `game.${id}`), loadPlayers()]);
    if (!current(seq)) return;
    S.undo = [];
    S.showAll = false;
    S.extraShown = new Set();
    if (cached) S.offline = true;
    setGame(d);
    renderBoard(true);
    startPoll(id, seq);
    keepAwake(true);
    flushQueue();
  }

  const onGameScreen = (id) => location.hash === `#/game/${id}`;

  function setGame(d) {
    cachePut(`game.${d.game.id}`, d);
    S.game = d;
    S.statsById = new Map(d.stats.map((r) => [r.id, r]));
  }

  // New server numbers (after sending taps, or from polling).
  function applyGame(d) {
    if (!d || !S.game || d.game.id !== S.game.game.id || !onGameScreen(d.game.id)) return;
    setGame(d);
    if (boardLayout() !== S.layoutSig) renderBoard(false);
    else paintLive();
  }

  // Pending = tapped on this phone, not confirmed by the server yet.
  function pending(pid, stat) {
    let n = 0;
    const gid = S.game.game.id;
    for (const x of S.queue) {
      if (x.gameId === gid && x.payload.stat === stat && (x.payload.player_id ?? null) === pid) n += x.payload.delta;
    }
    return n;
  }
  function val(pid, stat) {
    if (stat === 'opp') return S.game.score.them + pending(null, 'opp');
    return (S.statsById.get(pid)?.[stat] ?? 0) + pending(pid, stat);
  }
  function ourScore() {
    const gid = S.game.game.id;
    return S.game.score.us + S.queue.filter((x) => x.gameId === gid && x.payload.stat === 'g').reduce((n, x) => n + x.payload.delta, 0);
  }
  const pendingCount = () => S.queue.filter((x) => x.gameId === S.game.game.id).length;

  function boardPlayers() {
    const inGame = new Set(S.game.stats.map((r) => r.id));
    // A late arrival tapped from "Not in today's lineup" stays in that section until the page is reopened,
    // so the cards under a finger never jump.
    const main = S.players.filter((p) => inGame.has(p.id) && !S.extraShown.has(p.id)).sort(byNum);
    const extra = S.showAll
      ? S.players.filter((p) => S.extraShown.has(p.id) || (p.active && !inGame.has(p.id))).sort(byNum)
      : [];
    return { main, extra };
  }
  function boardLayout() {
    const { main, extra } = boardPlayers();
    return JSON.stringify([S.game.game, main.map((p) => p.id), extra.map((p) => p.id)]);
  }

  function renderBoard(toTop) {
    const { game } = S.game;
    const { main, extra } = boardPlayers();
    extra.forEach((p) => S.extraShown.add(p.id));
    const hidden = S.players.filter((p) => p.active && !S.statsById.has(p.id)).length;
    S.layoutSig = boardLayout();
    const y = window.scrollY;
    $app.innerHTML = `
      <div class="topline">
        <a class="back" href="#/">‹ Games</a>
        <a class="link-btn" href="#/game/${game.id}/edit">Edit game</a>
      </div>
      <div class="scoreboard">
        <div class="sb-meta">${esc(fmtDate(game.date, true))}</div>
        <div class="sb-row">
          <div class="sb-us"><div class="sb-name">${esc(S.config.teamName)}</div><div class="sb-num" data-k="us">0</div></div>
          <div class="sb-dash">–</div>
          <div><div class="sb-name">${esc(game.opponent)}</div><div class="sb-num" data-k="them">0</div></div>
        </div>
        <div class="sb-opp">
          <span>Their goals</span>
          <button type="button" class="sb-btn" data-action="tap" data-stat="opp" data-d="-1" aria-label="Take away one of their goals">−</button>
          <button type="button" class="sb-btn plus" data-action="tap" data-stat="opp" data-d="1" aria-label="They scored">+1</button>
        </div>
      </div>
      <p class="board-hint"><b>We score:</b> + Goal and + Assist for who did it, and <b>+</b> on +/− for each of our skaters on the ice.
        <b>They score:</b> <b>−</b> on +/− for each of our skaters on the ice.</p>
      <div class="board-bar">
        <div class="bb-top">
          <button type="button" class="bb-undo" id="undo-btn" data-action="undo" disabled>↶ Undo</button>
          <span class="bb-score"><span data-k="us">0</span>–<span data-k="them">0</span></span>
        </div>
        <div class="bb-status" id="bb-status" role="status"></div>
        <div class="bb-cols" aria-hidden="true"><span>Goals</span><span>Assists</span><span>+/−</span></div>
      </div>
      <div class="pcards">${main.map((p) => playerCard(p)).join('')}</div>
      ${extra.length ? `<h2 class="section-title">Not in today's lineup</h2><div class="pcards">${extra.map((p) => playerCard(p)).join('')}</div>` : ''}
      ${!S.showAll && hidden ? `<div class="center mt"><button type="button" class="btn-text" data-action="show-all">Player missing? Show everyone (${hidden})</button></div>` : ''}`;
    window.scrollTo(0, toTop ? 0 : y);
    paintLive();
  }

  function playerCard(p) {
    const [first, last] = splitName(p.name);
    return `<div class="pcard">
      <div class="pc-head">
        <span class="num-badge">${esc(numOf(p))}</span>
        <span class="pc-name">${esc(last)}<span class="pc-first">${esc(first)}</span></span>
        <button type="button" class="pos-tag" data-action="cycle-pos" data-pos="${p.id}"></button>
      </div>
      <div class="pc-stats">
        ${statCtrl(p, 'g', 'Goals')}
        ${statCtrl(p, 'a', 'Assists')}
        ${statCtrl(p, 'pm', 'Plus/minus')}
      </div>
    </div>`;
  }

  function statCtrl(p, stat, label) {
    const who = `${label} for ${p.name}`;
    return `<div class="pc-stat">
      <div class="pc-ctrl">
        <button type="button" class="pc-btn minus ${stat === 'pm' ? 'pm' : ''}" data-action="tap" data-pid="${p.id}" data-stat="${stat}" data-d="-1" aria-label="Minus one: ${esc(who)}">−</button>
        <span class="pc-val" data-k="${p.id}:${stat}">0</span>
        <button type="button" class="pc-btn plus" data-action="tap" data-pid="${p.id}" data-stat="${stat}" data-d="1" aria-label="Plus one: ${esc(who)}">+</button>
      </div>
    </div>`;
  }

  // Update numbers and banners in place (never rebuild the buttons someone might be tapping).
  function paintLive() {
    if (!S.game || !onGameScreen(S.game.game.id) || (S.config.needsCode && !S.config.authed)) return;
    for (const el of $app.querySelectorAll('[data-k]')) {
      const k = el.dataset.k;
      let text;
      if (k === 'us') text = String(ourScore());
      else if (k === 'them') text = String(val(null, 'opp'));
      else {
        const [pid, stat] = k.split(':');
        const v = val(Number(pid), stat);
        text = stat === 'pm' ? fmtPM(v) : String(v);
        el.className = `pc-val ${stat === 'pm' ? pmCls(v) : v ? '' : 'zero'}`;
      }
      if (el.textContent !== text) el.textContent = text;
    }
    for (const b of $app.querySelectorAll('[data-pos]')) {
      const pid = Number(b.dataset.pos);
      const pos = curPos(pid);
      const text = pos || 'Pos?';
      if (b.textContent !== text) b.textContent = text;
      b.className = `pos-tag pos-${pos || 'none'}`;
      b.setAttribute('aria-label', `Position today: ${POS[pos] || 'not set'}. Tap to change.`);
    }
    for (const b of $app.querySelectorAll('[data-action="tap"][data-d="-1"]')) {
      if (b.dataset.stat === 'pm') continue;
      b.disabled = val(b.dataset.pid ? Number(b.dataset.pid) : null, b.dataset.stat) <= 0;
    }
    const status = document.getElementById('bb-status');
    if (status) {
      const n = pendingCount();
      let text = 'All taps saved ✓';
      let cls = 'ok';
      if (n && S.offline) [text, cls] = [`No signal — ${n} tap${n > 1 ? 's' : ''} saved on this phone, will send`, 'warn'];
      else if (n) [text, cls] = ['Saving…', ''];
      if (S.game.other_phones && !(n && S.offline)) [text, cls] = ['⚠ Another phone is tapping this game — only one person should tap', 'warn'];
      if (status.textContent !== text) status.textContent = text;
      status.className = `bb-status ${cls}`;
    }
    paintUndo();
  }

  // Undo always sits in the same spot (the sticky bar) — it never pops up under a finger.
  const STAT_WORD = { g: 'goal', a: 'assist', pm: '+/−', opp: 'their goal' };
  function paintUndo() {
    const btn = document.getElementById('undo-btn');
    if (!btn) return;
    const last = S.undo[S.undo.length - 1];
    btn.disabled = !last;
    let text = '↶ Undo';
    if (last) {
      const t = last.t;
      const sign = t.delta > 0 ? '+1' : '−1';
      text += t.stat === 'opp' ? ` ${sign} their goal` : ` ${sign} ${STAT_WORD[t.stat]} ${shortName(t.player_id)}`;
    }
    if (btn.textContent !== text) btn.textContent = text;
  }

  // Position for this game, with a just-tapped change shown right away.
  const curPos = (pid) => (S.posPending.has(pid) ? S.posPending.get(pid) : S.statsById.get(pid)?.position ?? null);

  // Tap the C / W / D tag on a card to switch that kid's position for this game: C → W → D → C.
  function cyclePos(el) {
    if (!S.game) return;
    const pid = toId(el.dataset.pos);
    const gameId = S.game.game.id;
    const order = ['C', 'W', 'D'];
    const next = order[(order.indexOf(curPos(pid)) + 1) % order.length];
    S.posPending.set(pid, next);
    haptic();
    paintLive();
    S.posChain = S.posChain.then(async () => {
      try {
        const d = await api('PUT', `/api/games/${gameId}/players/${pid}`, { position: next });
        if (S.posPending.get(pid) === next) S.posPending.delete(pid);
        applyGame(d);
      } catch (e) {
        if (S.posPending.get(pid) === next) S.posPending.delete(pid);
        paintLive();
        if (!e.silent) toast(e.network ? 'No signal — position not changed. Tap it again.' : e.message);
      }
    });
  }

  function doTap(el) {
    if (!S.game) return;
    const stat = el.dataset.stat;
    const delta = Number(el.dataset.d);
    const pid = stat === 'opp' ? null : toId(el.dataset.pid);
    if (stat !== 'opp' && !pid) return;
    // An accidental double-tap on the same button counts once.
    const key = `${pid}:${stat}:${delta}`;
    const now = performance.now();
    if (S.lastTap && S.lastTap.key === key && now - S.lastTap.t < 350) return;
    S.lastTap = { key, t: now };
    if (delta < 0 && stat !== 'pm' && val(pid, stat) <= 0) return;
    const t = { client_id: randomId(), player_id: pid, stat, delta };
    S.queue.push({ gameId: S.game.game.id, payload: t });
    saveQueue();
    S.undo.push({ t });
    if (S.undo.length > 50) S.undo.shift();
    haptic();
    paintLive();
    bump(pid, stat);
    flushQueue();
  }

  function bump(pid, stat) {
    const el = $app.querySelector(stat === 'opp' ? '[data-k="them"]' : `[data-k="${pid}:${stat}"]`);
    if (!el) return;
    el.classList.remove('bump');
    void el.offsetWidth; // restart the animation
    el.classList.add('bump');
  }

  function undoLast() {
    const now = performance.now();
    if (now - S.lastUndoAt < 400) return; // an accidental double tap undoes once
    S.lastUndoAt = now;
    const u = S.undo.pop();
    if (!u || !S.game) return;
    const i = S.queue.findIndex((x) => x.payload.client_id === u.t.client_id);
    if (i >= 0 && !S.queue[i].sent) {
      S.queue.splice(i, 1); // never left the phone — just forget it
    } else {
      S.queue.push({ gameId: S.game.game.id, payload: { ...u.t, client_id: randomId(), delta: -u.t.delta } });
    }
    saveQueue();
    haptic();
    paintLive();
    bump(u.t.player_id, u.t.stat);
    flushQueue();
  }

  function startPoll(id, seq) {
    stopPoll();
    const tick = async () => {
      if (document.hidden || !current(seq)) return;
      flushQueue();
      try {
        const d = await api('GET', `/api/games/${id}`);
        if (!current(seq)) return;
        S.offline = false;
        if (d.stats.some((r) => !P(r.id))) await loadPlayers();
        applyGame(d);
      } catch {
        /* try again next tick */
      }
    };
    S.poll = { timer: setInterval(tick, 5000), tick };
  }
  function stopPoll() {
    if (S.poll) clearInterval(S.poll.timer);
    S.poll = null;
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !S.poll) return;
    S.poll.tick();
    keepAwake(true);
  });

  // ---------- stats tables ----------

  const COLS = [
    { key: 'number', label: '#', cls: '' },
    { key: 'name', label: 'Player', cls: 'left' },
    { key: 'gp', label: 'GP', cls: '' },
    { key: 'g', label: 'G', cls: '' },
    { key: 'a', label: 'A', cls: '' },
    { key: 'pts', label: 'PTS', cls: '' },
    { key: 'pm', label: '+/−', cls: '' },
  ];

  function statsTable(rows) {
    if (!rows.length) return '<div class="empty small">Nobody yet.</div>';
    const head = COLS.map((c) => {
      const sorted = S.statsSort.key === c.key;
      const arrow = sorted ? (S.statsSort.dir < 0 ? ' ▼' : ' ▲') : '';
      return `<th class="${c.cls} sortable ${sorted ? 'sorted' : ''}" data-action="sort" data-key="${c.key}" scope="col">${c.label}${arrow}</th>`;
    }).join('');
    const body = rows.map((r) => {
      const [first, last] = splitName(r.name);
      return `<tr>
        <td><span class="num-badge">${esc(numOf(r))}</span></td>
        <td class="left name"><a href="#/player/${r.id}">${esc(last)}<span class="tn-first">${esc(withPos(first, r))}</span></a></td>
        <td class="${r.gp ? '' : 'zero'}">${r.gp}</td>
        <td class="${r.g ? '' : 'zero'}">${r.g}</td>
        <td class="${r.a ? '' : 'zero'}">${r.a}</td>
        <td class="pts ${r.pts ? '' : 'zero'}">${r.pts}</td>
        <td class="${pmCls(r.pm)}">${fmtPM(r.pm)}</td>
      </tr>`;
    }).join('');
    return `<div class="table-wrap"><table class="stats"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  }

  function sortRows(rows) {
    const { key, dir } = S.statsSort;
    const v = (r) => (key === 'name' ? splitName(r.name)[1].toLowerCase() : key === 'number' ? (r.number ?? 999) : r[key]);
    return [...rows].sort((a, b) => {
      const x = v(a);
      const y = v(b);
      if (x < y) return -dir;
      if (x > y) return dir;
      return b.pts - a.pts || b.g - a.g || b.pm - a.pm || byNum(a, b);
    });
  }

  // ---------- season stats ----------

  async function viewStats(seq) {
    const { data: d, cached } = await fetchOrCache('/api/stats', 'stats');
    if (!current(seq)) return;
    S.stats = d;
    paint(seq, `
      ${cached ? '<div class="notice">No signal — showing the last saved stats.</div>' : ''}
      <h1 class="page-title">Season stats</h1>
      <div id="season-stats">${renderStatsBody()}</div>`);
  }

  // Record, goals for/against and the per-player table — on the Stats tab and under the games on the home page.
  function renderStatsBody() {
    const d = S.stats;
    const { w, l, t } = d.record;
    return `
      <div class="summary">
        <div class="card"><div class="big">${w}-${l}-${t}</div><div class="lbl">W-L-T</div></div>
        <div class="card"><div class="big">${d.goals_for}</div><div class="lbl">Goals for</div></div>
        <div class="card"><div class="big">${d.goals_against}</div><div class="lbl">Goals against</div></div>
      </div>
      ${statsTable(sortRows(d.players))}
      <p class="hint mt">Tap a column to sort. Tap a name to see every game.</p>
      <a class="btn btn-light mt" href="/api/stats.csv" download>Download as spreadsheet</a>`;
  }

  // ---------- one player ----------

  async function viewPlayer(seq, id) {
    if (!id) throw new Error('Player not found');
    const d = await api('GET', `/api/players/${id}`);
    const p = d.player;
    const t = d.totals;
    const [first, last] = splitName(p.name);
    paint(seq, `
      <div class="topline"><a class="back" href="#/stats">‹ Season stats</a></div>
      <div class="player-head">
        <span class="num-badge">${esc(numOf(p))}</span>
        <div><div class="muted">${esc(withPos(first, p))}${p.active ? '' : ' · not on team'}</div><h1>${esc(last)}</h1></div>
      </div>
      <div class="table-wrap"><table class="stats"><thead><tr>
        <th scope="col">GP</th><th scope="col">G</th><th scope="col">A</th><th scope="col">PTS</th><th scope="col">+/−</th>
      </tr></thead><tbody><tr>
        <td>${t.gp}</td><td>${t.g}</td><td>${t.a}</td><td class="pts">${t.pts}</td><td class="${pmCls(t.pm)}">${fmtPM(t.pm)}</td>
      </tr></tbody></table></div>
      <h2 class="section-title">Game by game</h2>
      ${d.games.length ? `<div class="table-wrap"><table class="stats"><thead><tr>
        <th class="left" scope="col">Game</th><th scope="col">G</th><th scope="col">A</th><th scope="col">PTS</th><th scope="col">+/−</th>
      </tr></thead><tbody>${d.games.map((g) => {
        const r = resultOf(g.us, g.them);
        const res = g.played ? `<span class="res-txt res-txt-${r}">${r} ${g.us}–${g.them}</span>` : `${g.us}–${g.them}`;
        return `<tr>
          <td class="left"><a class="pg-link" href="#/game/${g.game_id}"><span class="pg-opp">vs ${esc(g.opponent)}</span>
            <span class="pg-meta">${esc(fmtDate(g.date))} · ${res}${POS[g.position] ? ` · ${POS[g.position]}` : ''}</span></a></td>
          <td class="${g.g ? '' : 'zero'}">${g.g}</td><td class="${g.a ? '' : 'zero'}">${g.a}</td>
          <td class="pts ${g.pts ? '' : 'zero'}">${g.pts}</td><td class="${pmCls(g.pm)}">${fmtPM(g.pm)}</td>
        </tr>`;
      }).join('')}</tbody></table></div>` : '<div class="empty small">No games yet.</div>'}`);
  }

  // ---------- roster ----------

  async function viewRoster(seq) {
    await loadPlayers();
    const active = S.players.filter((p) => p.active).sort(byNum);
    const gone = S.players.filter((p) => !p.active).sort(byNum);
    const item = (p) => `<li><button type="button" class="roster-item ${p.active ? '' : 'inactive'}" data-action="edit-player" data-id="${p.id}">
      <span class="num-badge">${esc(numOf(p))}</span>
      <span class="ri-name">${esc(p.name)}</span>
      <span class="ri-edit">Edit</span>
    </button></li>`;
    paint(seq, `
      <h1 class="page-title">Roster <span class="muted count-small">${active.length} players</span></h1>
      <button type="button" class="btn btn-green" data-action="add-player">＋ Add player</button>
      <ul class="roster-list mt">${active.map(item).join('')}</ul>
      ${gone.length ? `<h2 class="section-title">Not on the team anymore</h2><ul class="roster-list">${gone.map(item).join('')}</ul>` : ''}
      <h2 class="section-title">Save a copy</h2>
      <div class="card">
        <p class="hint">Download everything (players, games, stats) in case you ever need it.</p>
        <a class="btn btn-light" href="/api/stats.csv" download>Season stats spreadsheet</a>
        <a class="btn btn-light mt" href="/api/backup" download>Full backup file</a>
      </div>`);
  }

  function openPlayerSheet(p) {
    $sheet.innerHTML = `
      <div class="sheet-head neutral">
        <h2>${p ? 'Edit player' : 'Add player'}</h2>
        <button type="button" class="sheet-close" data-action="close-sheet" aria-label="Close">×</button>
      </div>
      <form class="sheet-body" data-form="player" data-id="${p ? p.id : ''}" novalidate autocomplete="off">
        <div class="sheet-body-inner">
          <label class="field"><span class="field-label">Name</span>
            <input class="input" name="name" maxlength="40" value="${esc(p?.name ?? '')}" placeholder="First Last" autocapitalize="words"></label>
          <label class="field"><span class="field-label">Jersey number</span>
            <input class="input" name="number" type="number" inputmode="numeric" min="0" max="99" value="${esc(p?.number ?? '')}"></label>

          <div id="form-error"></div>
          <button class="btn btn-green mt" type="submit">Save</button>
          ${p ? (p.active
            ? `<button type="button" class="btn btn-danger-outline mt-lg" data-action="remove-player" data-id="${p.id}">Remove from team</button>`
            : `<button type="button" class="btn btn-light mt-lg" data-action="restore-player" data-id="${p.id}">Put back on the team</button>`) : ''}
        </div>
      </form>`;
    openSheet();
    if (!p) $sheet.querySelector('input[name=name]').focus();
  }

  async function submitPlayer(form) {
    const id = toId(form.dataset.id);
    const body = {
      name: form.name.value.trim(),
      number: form.number.value === '' ? null : Number(form.number.value),
    };
    if (!body.name) return formError('Type a name.', form.name);
    if (body.number !== null && (!Number.isInteger(body.number) || body.number < 0 || body.number > 99)) {
      return formError('Jersey number must be 0–99.', form.number);
    }
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      if (id) await api('PUT', `/api/players/${id}`, body);
      else await api('POST', '/api/players', body);
      closeSheet();
      S.pendingToast = id ? 'Saved ✓' : `${body.name} added ✓`;
      route();
    } catch (e) {
      if (!e.silent) formError(e.message);
      btn.disabled = false;
    }
  }

  // ---------- actions (event delegation) ----------

  const actions = {
    retry: () => route(),
    reload: () => location.reload(),
    'toast-action': async () => {
      const fn = S.toastFn;
      hideToast();
      if (fn) await fn();
    },
    'close-sheet': () => closeSheet(),

    tap: (el) => doTap(el),
    undo: () => undoLast(),
    'show-all': () => {
      S.showAll = true;
      renderBoard(false);
    },

    'set-lineup': (el) => {
      const f = S.form;
      const id = toId(el.dataset.id);
      const v = el.dataset.v;
      if (v === 'OUT') {
        if (f.dressed.has(id)) f.dressed.delete(id);
        else f.dressed.add(id); // tapping OUT again puts them back in
      } else {
        f.dressed.add(id);
        f.pos.set(id, v);
      }
      const p = P(id);
      if (p) el.closest('.lu-row').outerHTML = lineupRow(p);
      updateLineupCount();
    },
    'cycle-pos': (el) => cyclePos(el),
    'delete-game': async () => {
      if (!S.form?.id || !confirm('Delete this game and all its stats?\n\nThis cannot be undone.')) return;
      await api('DELETE', `/api/games/${S.form.id}`);
      S.queue = S.queue.filter((x) => x.gameId !== S.form.id);
      saveQueue();
      S.pendingToast = 'Game deleted';
      location.replace('#/');
    },

    sort: (el) => {
      const key = el.dataset.key;
      const s = S.statsSort;
      if (s.key === key) s.dir = -s.dir;
      else Object.assign(s, { key, dir: key === 'name' || key === 'number' ? 1 : -1 });
      const box = document.getElementById('season-stats');
      if (box && S.stats) box.innerHTML = renderStatsBody(); // only the stats redraw; the page stays put
    },
    'all-games': (el) => {
      // Expand the list right where it is: no reload, no jump back to the top.
      S.showAllGames = true;
      const list = document.querySelector('.game-list');
      if (list && S.games) list.innerHTML = S.games.map(gameCard).join('');
      el.closest('.center')?.remove();
    },
    'retry-season': async () => {
      const box = document.getElementById('season-stats');
      if (!box) return;
      box.innerHTML = '<div class="loading">Loading…</div>';
      const seq = S.seq;
      const s = await fetchOrCache('/api/stats', 'stats').catch((error) => ({ error }));
      if (current(seq)) fillSeason(s);
    },

    'add-player': () => openPlayerSheet(null),
    'edit-player': (el) => {
      const p = P(toId(el.dataset.id));
      if (p) openPlayerSheet(p);
    },
    'remove-player': async (el) => {
      const p = P(toId(el.dataset.id));
      if (!p || !confirm(`Remove ${p.name} from the team?\n\nTheir past stats are kept.`)) return;
      await api('DELETE', `/api/players/${p.id}`);
      closeSheet();
      S.pendingToast = `${p.name} removed`;
      route();
    },
    'restore-player': async (el) => {
      const id = toId(el.dataset.id);
      await api('PUT', `/api/players/${id}`, { active: true });
      closeSheet();
      S.pendingToast = 'Back on the team ✓';
      route();
    },
  };

  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-action]');
    if (!el || el.disabled) return;
    const fn = actions[el.dataset.action];
    if (!fn) return;
    e.preventDefault();
    try {
      await fn(el, e);
    } catch (err) {
      if (!err.silent) toast(err.message);
    }
  });

  document.addEventListener('submit', (e) => {
    const form = e.target.closest('form[data-form]');
    if (!form) return;
    e.preventDefault();
    const kind = form.dataset.form;
    if (kind === 'login') submitLogin(form);
    else if (kind === 'game') submitGameForm(form);
    else if (kind === 'player') submitPlayer(form);
  });

  // The keyboard's Enter key on the opponent box just closes the keyboard (it must not start the game).
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches?.('input[name=opponent]')) {
      e.preventDefault();
      e.target.blur();
    }
  });

  // ---------- boot ----------

  window.addEventListener('hashchange', route);

  (async function boot() {
    try {
      S.config = await api('GET', '/api/config');
    } catch (e) {
      $app.innerHTML = `<div class="error-box">${esc(e.message)}</div><button class="btn btn-light mt" data-action="reload">Try again</button>`;
      return;
    }
    document.getElementById('team-name').textContent = S.config.teamName;
    document.title = `${S.config.teamName} · Stats`;
    route();
    flushQueue();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  })();
})();
