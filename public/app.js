/* goose-pwa client — talks ACP directly to `goose serve` over WebSocket. */

'use strict';

/* ------------------------------------------------------------------ */
/* tiny helpers                                                        */
/* ------------------------------------------------------------------ */

const $ = (sel) => document.querySelector(sel);

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const store = {
  get(k, d = null) {
    try {
      const v = localStorage.getItem('goose-pwa:' + k);
      return v === null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem('goose-pwa:' + k, JSON.stringify(v));
    } catch { /* private mode etc. */ }
  },
  del(k) {
    try {
      localStorage.removeItem('goose-pwa:' + k);
    } catch { /* private mode etc. */ }
  },
};

const clientId = store.get('clientId') ?? (() => {
  const id = Math.random().toString(36).slice(2, 10);
  store.set('clientId', id);
  return id;
})();

/* ------------------------------------------------------------------ */
/* minimal markdown renderer (safe: escapes HTML first)                */
/* ------------------------------------------------------------------ */

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderMarkdown(src) {
  const codeBlocks = [];
  let text = src.replace(/```(\w*)\n?([\s\S]*?)(?:```|$)/g, (_, lang, code) => {
    codeBlocks.push(`<pre><code class="lang-${escapeHtml(lang)}">${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`);
    return `${codeBlocks.length - 1}`;
  });

  text = escapeHtml(text);

  // inline
  text = text.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/(^|\W)\*([^*\n]+)\*/g, '$1<em>$2</em>');
  text = text.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  text = text.replace(/(?<!["'=])(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');

  // blocks
  const lines = text.split('\n');
  const out = [];
  let para = [];
  let list = null; // 'ul' | 'ol'
  let quote = [];

  const flushPara = () => {
    if (para.length) { out.push('<p>' + para.join('<br>') + '</p>'); para = []; }
  };
  const flushList = () => {
    if (list) { out.push(`<${list.tag}>${list.items.map((i) => `<li>${i}</li>`).join('')}</${list.tag}>`); list = null; }
  };
  const flushQuote = () => {
    if (quote.length) { out.push('<blockquote>' + quote.join('<br>') + '</blockquote>'); quote = []; }
  };
  const flushAll = () => { flushPara(); flushList(); flushQuote(); };

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const trimmed = line.trim();
    const codeM = trimmed.match(/^(\d+)$/);
    if (codeM && codeBlocks[Number(codeM[1])] !== undefined) {
      flushAll();
      out.push(codeBlocks[Number(codeM[1])]);
      continue;
    }
    // pipe table: header row + separator row (+ body rows)
    if (trimmed.startsWith('|') && li + 1 < lines.length && /^\|[\s:|-]+\|?$/.test(lines[li + 1].trim()) && lines[li + 1].includes('-')) {
      flushAll();
      const splitRow = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = splitRow(trimmed);
      li++; // separator row
      const bodyRows = [];
      while (li + 1 < lines.length && lines[li + 1].trim().startsWith('|')) {
        li++;
        bodyRows.push(splitRow(lines[li]));
      }
      out.push(
        '<table><thead><tr>' + head.map((c) => `<th>${c}</th>`).join('') + '</tr></thead><tbody>'
        + bodyRows.map((r) => '<tr>' + r.map((c) => `<td>${c}</td>`).join('') + '</tr>').join('')
        + '</tbody></table>',
      );
      continue;
    }
    const h = trimmed.match(/^(#{1,4})\s+(.*)$/);
    if (h) { flushAll(); out.push(`<h${h[1].length}>${h[2]}</h${h[1].length}>`); continue; }
    if (/^(-{3,}|\*{3,})$/.test(trimmed)) { flushAll(); out.push('<hr>'); continue; }
    const ul = trimmed.match(/^[-*•]\s+(.*)$/);
    if (ul) {
      flushPara(); flushQuote();
      if (!list || list.tag !== 'ul') { flushList(); list = { tag: 'ul', items: [] }; }
      list.items.push(ul[1]);
      continue;
    }
    const ol = trimmed.match(/^\d+[.)]\s+(.*)$/);
    if (ol) {
      flushPara(); flushQuote();
      if (!list || list.tag !== 'ol') { flushList(); list = { tag: 'ol', items: [] }; }
      list.items.push(ol[1]);
      continue;
    }
    const q = trimmed.match(/^>\s?(.*)$/);
    if (q) { flushPara(); flushList(); quote.push(q[1]); continue; }
    if (trimmed === '') { flushAll(); continue; }
    flushList(); flushQuote();
    para.push(trimmed);
  }
  flushAll();
  return out.join('');
}

/* ------------------------------------------------------------------ */
/* state                                                               */
/* ------------------------------------------------------------------ */

const state = {
  token: store.get('token'), // the goose serve secret key (GOOSE_SERVER__SECRET_KEY)
  sessionId: store.get('sessionId'),
  sessionTitle: store.get('sessionTitle', 'Goose'),
  defaultCwd: null,
  agentInfo: null,
  modes: null,
  configOptions: null,
  commands: [],
  sessionList: null,
  pending: new Map(), // rpc id -> {resolve, reject, timer, method}
  tools: new Map(),   // toolCallId -> {card, body, title}
  stream: null,       // open streaming bubble {kind, el, text}
  busy: false,
  ws: null,
  reconnects: 0,
  pinned: true,
  lastActivity: 0,  // last message from the server, for the liveness probe
  probing: false,
  probe: 'idle',    // liveness probe: idle | checking | alive | dead
  lastProbeAt: 0,
  turnStartedAt: 0,
  replaying: false, // true while session/load replays history
  stalled: false,
};

let rpcCounter = 1;

/* ------------------------------------------------------------------ */
/* transport: one WebSocket straight to goose serve (/acp)             */
/* ------------------------------------------------------------------ */

function wsSend(msg) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    throw new Error('not connected');
  }
  state.ws.send(JSON.stringify(msg));
}

function rpc(method, params, { timeoutMs = 10 * 60 * 1000 } = {}) {
  const id = `c${clientId}-${rpcCounter++}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pending.delete(id);
      reject(new Error(`${method}: timed out`));
    }, timeoutMs);
    state.pending.set(id, { resolve, reject, timer, method });
    try {
      wsSend({ jsonrpc: '2.0', id, method, params });
    } catch (err) {
      clearTimeout(timer);
      state.pending.delete(id);
      reject(err);
    }
  });
}

function notify(method, params) {
  try {
    wsSend({ jsonrpc: '2.0', method, params });
  } catch (err) {
    console.warn('notify failed', method, err);
  }
}

function respondToAgent(id, result) {
  try {
    wsSend({ jsonrpc: '2.0', id, result });
  } catch (err) {
    console.warn('respond failed', err);
  }
}

/* ----- auth (secret key) ----- */

function showAuthForm(message) {
  const hint = $('#welcome-hint');
  if (hint) hint.textContent = message;
  const form = $('#auth-form');
  if (form) {
    form.hidden = false;
    $('#auth-input').focus();
  }
}

function hideAuthForm() {
  const form = $('#auth-form');
  if (form) form.hidden = true;
}

/* ------------------------------------------------------------------ */
/* connection (WebSocket with reconnect + resync)                      */
/* ------------------------------------------------------------------ */

async function preflight() {
  // GET /acp-preflight (Caddy strips Origin and forwards to /acp):
  //   406 = key ok   404/401 = key missing/wrong   403 = origin rejected
  // Bound it: a suspended server must not leave a fetch hanging forever.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch('/acp-preflight', {
      signal: ctrl.signal,
      headers: state.token ? { 'X-Secret-Key': state.token } : {},
    });
    if (res.status === 406) return 'ok';
    if (res.status === 401 || res.status === 404) return 'auth:' + res.status;
    if (res.status === 403) return 'origin';
    return 'down:' + res.status;
  } catch {
    return 'down';
  } finally {
    clearTimeout(timer);
  }
}

async function connect() {
  setConnState('starting');
  if (state.ws) {
    state.ws.onclose = null;
    state.ws.close();
    state.ws = null;
    // a request in flight must not hang until its timeout
    failPending('connection lost');
  }

  const check = await preflight();
  if (check.startsWith('auth')) {
    setConnState('down');
    const code = check.split(':')[1] ?? '';
    showAuthForm(state.token
      ? `Secret key rejected (goose answered HTTP ${code}) — check it and retry:`
      : 'Enter the goose server secret key:');
    return;
  }
  if (check === 'origin') {
    setConnState('down');
    addSystemMessage(
      'goose rejected this origin. Restart goose serve with --allowed-origin ' +
        location.origin + ' (see README).',
      true,
    );
    return;
  }
  if (check.startsWith('down')) {
    setConnState('down');
    const hint = $('#welcome-hint');
    if (hint) hint.textContent = 'goose unreachable — retrying…';
    scheduleReconnect();
    return;
  }
  hideAuthForm();

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}/acp?token=${encodeURIComponent(state.token ?? '')}`;
  const ws = new WebSocket(url);
  state.ws = ws;
  let opened = false;

  ws.onopen = async () => {
    opened = true;
    state.reconnects = 0;
    state.lastActivity = Date.now();
    try {
      const init = await rpc('initialize', {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: 'goose-pwa', version: '1.0.0' },
      });
      state.agentInfo = init.agentInfo ?? null;
      setConnState('ready');
      const hint = $('#welcome-hint');
      if (hint) {
        hint.textContent = `${state.agentInfo?.name ?? 'goose'} ${state.agentInfo?.version ?? ''} · ready`;
      }
      await ensureSession();
    } catch (err) {
      addSystemMessage(`initialize failed: ${err.message}`, true);
      ws.close();
    }
  };

  ws.onmessage = (e) => {
    state.lastActivity = Date.now();
    state.probe = 'idle';
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    handleAgentMessage(msg);
  };

  ws.onclose = () => {
    if (state.ws !== ws) return; // superseded by a newer connection
    state.ws = null;
    setConnState('down');
    if (!opened) {
      // preflight passed (key ok) but the socket never opened: origin rejected
      addSystemMessage(
        'goose rejected this origin. Restart goose serve with --allowed-origin ' +
          location.origin + ' (see README).',
        true,
      );
      scheduleReconnect();
      return;
    }
    // fail all in-flight requests so the UI unblocks
    failPending('connection lost');
    scheduleReconnect();
  };

  ws.onerror = () => ws.close();
}

function scheduleReconnect() {
  const delay = Math.min(1500 * 2 ** state.reconnects++, 10000);
  setTimeout(connect, delay);
}

function setConnState(s) {
  const dot = $('#conn-dot');
  dot.className = 'dot ' + (s === 'ready' ? 'dot-ok' : s === 'starting' ? 'dot-busy' : 'dot-down');
  dot.title = `goose: ${s}`;
}

function failPending(reason) {
  for (const [, p] of state.pending) {
    clearTimeout(p.timer);
    p.reject(new Error(reason));
  }
  state.pending.clear();
}

/* Liveness. iOS suspends the PWA and can drop the socket without firing
 * onclose, leaving it OPEN and silent. While a turn runs, probe after a long
 * quiet period; when the app returns to the foreground, reconnect if the
 * socket is gone. */

const STALL_MS = 30_000;

async function probeConnection() {
  if (state.probing) return;
  const ws = state.ws;
  if (!ws || ws.readyState === WebSocket.CONNECTING) return;
  if (ws.readyState !== WebSocket.OPEN) {
    connect();
    return;
  }
  state.probing = true;
  state.probe = 'checking';
  state.lastActivity = Date.now(); // one probe per quiet period
  try {
    await rpc('session/list', {}, { timeoutMs: 8000 });
    state.probe = 'alive';
    state.lastProbeAt = Date.now();
  } catch {
    if (state.ws !== ws) return;
    state.probe = 'dead';
    state.stalled = true;
    addSystemMessage('Connection stalled — reconnecting…', true);
    connect();
  } finally {
    state.probing = false;
  }
}

function resumeConnection() {
  const ws = state.ws;
  if (ws && ws.readyState === WebSocket.CONNECTING) return;
  if (!ws || ws.readyState === WebSocket.CLOSED) {
    state.reconnects = 0;
    connect();
    return;
  }
  if (Date.now() - state.lastActivity > STALL_MS) probeConnection();
}

setInterval(() => {
  if (!state.busy || state.probing) return;
  if (Date.now() - state.lastActivity < STALL_MS) return;
  probeConnection();
}, 10_000);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  resumeConnection();
  maybeScroll();
});

window.addEventListener('pageshow', (e) => {
  if (e.persisted) resumeConnection();
});

/* ------------------------------------------------------------------ */
/* session lifecycle                                                   */
/* ------------------------------------------------------------------ */

// goose requires an absolute cwd for session/new and session/load; it has no
// server-side default, so a deployment without one cannot open a session.
function sessionCwd() {
  if (state.defaultCwd) return state.defaultCwd;
  throw new Error('No absolute "cwd" configured — set it in /config.json and reload');
}

async function ensureSession() {
  try {
    if (state.sessionId) {
      await loadSession(state.sessionId);
    } else {
      await newSession();
    }
  } catch (err) {
    console.warn('ensureSession failed, creating new:', err);
    state.sessionId = null;
    await newSession().catch((err2) => addSystemMessage(`Cannot create session: ${err2.message}`, true));
  }
}

async function newSession() {
  closeStream();
  clearChat();
  const result = await rpc('session/new', { cwd: sessionCwd(), mcpServers: [] });
  state.sessionId = result.sessionId;
  state.sessionTitle = 'New chat';
  applySessionMeta(result);
  store.set('sessionId', state.sessionId);
  store.set('sessionTitle', state.sessionTitle);
  renderTitle();
  addSystemMessage('New session started');
}

async function loadSession(sessionId) {
  const previousSessionId = state.sessionId;
  closeStream();
  clearChat();
  const loadingEl = addSystemMessage('Loading session…');

  // Point state at the target session *before* the load round-trip so the
  // history-replay `session/update` notifications goose emits during
  // `session/load` are not filtered out by handleSessionUpdate() (which drops
  // updates whose sessionId differs from the current one).
  state.sessionId = sessionId;
  store.set('sessionId', sessionId);

  state.replaying = true;
  try {
    const result = await rpc('session/load', { sessionId, cwd: sessionCwd(), mcpServers: [] });
    state.sessionId = result.sessionId ?? sessionId;
    applySessionMeta(result);
    store.set('sessionId', state.sessionId);
  } catch (err) {
    state.sessionId = previousSessionId;
    store.set('sessionId', previousSessionId);
    throw err;
  } finally {
    state.replaying = false;
    loadingEl.remove();
  }
  closeStream();
  refreshSessionTitle();
}

function applySessionMeta(result) {
  if (result?.modes) {
    state.modes = result.modes;
    renderModePill(result.modes.currentModeId);
  }
  if (result?.configOptions) state.configOptions = result.configOptions;
  applySavedConfigOptions();
}

// Re-apply the user's last chosen thinking effort to every session.
// goose resets new sessions to the server default (GOOSE_THINKING_EFFORT),
// so a per-session pick otherwise looks like it never sticks.
async function applySavedConfigOptions() {
  const saved = store.get('thinkingEffort');
  if (!saved || !state.sessionId) return;
  const cfg = (state.configOptions || []).find((c) => c.id === 'thinking_effort');
  if (!cfg || cfg.currentValue === saved) return;
  try {
    const r = await rpc('session/set_config_option', {
      sessionId: state.sessionId,
      configId: 'thinking_effort',
      value: saved,
    });
    if (r?.configOptions) state.configOptions = r.configOptions;
  } catch { /* non-fatal */ }
}

async function refreshSessionTitle() {
  try {
    const { sessions } = await rpc('session/list', {}, { timeoutMs: 15000 });
    const mine = sessions.find((s) => s.sessionId === state.sessionId);
    if (mine?.title) {
      state.sessionTitle = mine.title;
      store.set('sessionTitle', mine.title);
      renderTitle();
    }
  } catch { /* non-fatal */ }
}

function renderTitle() {
  $('#session-title').textContent = state.sessionTitle || 'Goose';
}

function renderModePill(modeId) {
  $('#mode-pill').textContent = modeId || '…';
}

/* ------------------------------------------------------------------ */
/* incoming ACP messages                                               */
/* ------------------------------------------------------------------ */

function handleAgentMessage(msg) {
  // response to one of our requests?
  if (msg.id !== undefined && msg.method === undefined) {
    const p = state.pending.get(msg.id);
    if (p) {
      state.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) {
        p.reject(new Error(msg.error.message || 'RPC error'));
        if (p.method === 'session/prompt') setBusy(false);
      } else {
        p.resolve(msg.result);
      }
    }
    return;
  }

  // agent -> client request
  if (msg.method && msg.id !== undefined) {
    if (msg.method === 'session/request_permission') {
      showPermissionRequest(msg.id, msg.params);
    } else {
      // we declared no fs/terminal capabilities; reject anything unexpected
      respondToAgentError(msg.id);
    }
    return;
  }

  // notification
  if (msg.method === 'session/update') {
    handleSessionUpdate(msg.params);
  }
}

function respondToAgentError(id) {
  try {
    wsSend({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: 'Method not found' },
    });
  } catch { /* not connected */ }
}

function handleSessionUpdate({ sessionId, update }) {
  if (!update) return;
  if (sessionId && state.sessionId && sessionId !== state.sessionId) return;

  switch (update.sessionUpdate) {
    case 'user_message_chunk':
      appendChunk('user', update.content);
      break;
    case 'agent_message_chunk':
      appendChunk('agent', update.content);
      break;
    case 'agent_thought_chunk':
      appendChunk('thought', update.content);
      break;
    case 'tool_call':
      closeStream();
      upsertToolCall(update);
      break;
    case 'tool_call_update':
      upsertToolCall(update);
      break;
    case 'plan':
      closeStream();
      renderPlan(update.entries || []);
      break;
    case 'available_commands_update':
      state.commands = update.availableCommands || [];
      break;
    case 'current_mode_update':
      if (state.modes) state.modes.currentModeId = update.currentModeId;
      renderModePill(update.currentModeId);
      break;
    case 'usage_update':
    case 'session_info_update':
      break; // informational only
    default:
      break;
  }
}

/* ------------------------------------------------------------------ */
/* rendering                                                           */
/* ------------------------------------------------------------------ */

const chat = () => $('#chat');

function clearChat() {
  chat().innerHTML = '';
  state.tools.clear();
  state.stream = null;
  hideWelcome();
}

function hideWelcome() {
  const w = $('#welcome');
  if (w) w.remove();
}

function maybeScroll() {
  if (!state.pinned) return;
  const c = chat();
  c.scrollTop = c.scrollHeight;
}

function addSystemMessage(text, isError = false) {
  closeStream();
  hideWelcome();
  const m = el('div', 'msg system' + (isError ? ' error' : ''), text);
  chat().appendChild(m);
  maybeScroll();
  return m;
}

function closeStream() {
  if (!state.stream) return;
  const { kind, el: bubble, text, wrap } = state.stream;
  bubble.classList.remove('typing');
  if (wrap) wrap.classList.remove('streaming');
  if (kind === 'agent') bubble.innerHTML = renderMarkdown(text);
  state.stream = null;
}

function appendChunk(kind, content) {
  if (!content) return;
  hideWelcome();
  let text = '';
  if (content.type === 'text') text = content.text ?? '';
  else if (content.type === 'image') text = '[image]';
  else text = `[${content.type || 'content'}]`;

  if (state.stream && state.stream.kind === kind) {
    state.stream.text += text;
    if (kind === 'agent') {
      state.stream.el.innerHTML = renderMarkdown(state.stream.text);
    } else {
      state.stream.el.textContent = state.stream.text;
    }
  } else {
    closeStream();
    if (kind === 'thought') {
      // collapsed-by-default card; tap the header to reveal/hide the thought
      const wrap = el('div', 'msg thought streaming');
      const head = el('div', 'thought-head');
      head.appendChild(el('span', 'thought-label', 'Thinking'));
      head.appendChild(el('span', 'thought-chevron', '›'));
      const body = el('div', 'thought-body', text);
      wrap.appendChild(head);
      wrap.appendChild(body);
      head.addEventListener('click', () => {
        wrap.classList.toggle('open');
        maybeScroll();
      });
      chat().appendChild(wrap);
      state.stream = { kind, el: body, text, wrap };
    } else {
      const bubble = el('div', `msg ${kind} typing`);
      if (kind === 'agent') bubble.innerHTML = renderMarkdown(text);
      else bubble.textContent = text;
      chat().appendChild(bubble);
      state.stream = { kind, el: bubble, text };
    }
  }
  maybeScroll();
}

/* ----- tool calls ----- */

function shortTitle(title) {
  if (!title) return 'tool call';
  return title.length > 90 ? title.slice(0, 90) + '…' : title;
}

function upsertToolCall(u) {
  const id = u.toolCallId;
  if (!id) return;
  let t = state.tools.get(id);
  if (!t) {
    const card = el('div', 'tool');
    card.dataset.status = u.status || 'pending';
    const head = el('div', 'tool-head');
    head.appendChild(el('span', 'tool-status'));
    const title = el('span', 'tool-title', shortTitle(u.title));
    head.appendChild(title);
    const elapsedEl = el('span', 'tool-elapsed');
    elapsedEl.hidden = true;
    head.appendChild(elapsedEl);
    const chev = el('span', 'tool-chevron', '›');
    head.appendChild(chev);
    const body = el('div', 'tool-body');
    card.appendChild(head);
    card.appendChild(body);
    head.addEventListener('click', () => card.classList.toggle('open'));
    chat().appendChild(card);
    // a fresh tool_call often carries no status; ACP's default is pending.
    // During replay, a call with no completing update stays unfinished.
    const replayed = state.replaying;
    const settled = u.status === 'completed' || u.status === 'failed';
    const started = !replayed && !settled;
    t = {
      card, body, title, contentEl: null,
      startedAt: started ? Date.now() : 0,
      endedAt: 0,
      running: started,
      stale: replayed && !settled,
      elapsedEl,
    };
    state.tools.set(id, t);
    if (u.rawInput !== undefined) {
      t.body.appendChild(el('pre', null, formatRaw(u.rawInput)));
    }
  }
  if (u.title) t.title.textContent = shortTitle(u.title);
  if (u.status) {
    const running = u.status === 'in_progress' || u.status === 'pending';
    if (running && state.replaying) {
      // replayed mid-turn state: the connection that owned this turn is gone,
      // so label it unfinished instead of pretending it is running
      t.stale = true;
      t.running = false;
      t.card.dataset.status = 'stale';
    } else {
      t.stale = false;
      t.card.dataset.status = u.status;
      if (running) {
        if (!t.startedAt) t.startedAt = Date.now();
        t.running = true;
      } else {
        t.running = false;
        if (t.startedAt && !t.endedAt) t.endedAt = Date.now();
      }
    }
  }
  if (t.stale) {
    t.elapsedEl.hidden = false;
    t.elapsedEl.textContent = 'unfinished';
    t.elapsedEl.classList.remove('warn');
    if (t.card.dataset.status !== 'stale') t.card.dataset.status = 'stale';
  } else if (t.startedAt) {
    const ms = (t.endedAt ?? Date.now()) - t.startedAt;
    t.elapsedEl.hidden = false;
    t.elapsedEl.textContent = fmtDur(ms);
    t.elapsedEl.classList.toggle('warn', ms >= 5 * 60 * 1000);
  } else {
    t.elapsedEl.hidden = true;
    t.elapsedEl.textContent = '';
  }

  if (Array.isArray(u.content)) {
    // ACP sends the full content array on each update (replace semantics)
    if (!t.contentEl) {
      t.contentEl = el('div');
      t.body.appendChild(t.contentEl);
    }
    t.contentEl.innerHTML = '';
    for (const item of u.content) renderToolContent(t.contentEl, item);
  }
  maybeScroll();
}

function formatRaw(raw) {
  try {
    const s = JSON.stringify(raw, null, 2);
    return s.length > 4000 ? s.slice(0, 4000) + '\n… (truncated)' : s;
  } catch {
    return String(raw);
  }
}

function renderToolContent(body, item) {
  if (!item) return;
  if (item.type === 'content' && item.content) {
    const c = item.content;
    if (c.type === 'text') body.appendChild(el('pre', null, c.text || ''));
    else body.appendChild(el('pre', null, `[${c.type}]`));
  } else if (item.type === 'diff') {
    const wrap = el('div');
    wrap.appendChild(el('div', 'diff-path', item.path || ''));
    const pre = el('pre');
    if (item.oldText) {
      const del = el('div', 'diff-del');
      del.textContent = item.oldText.split('\n').map((l) => '- ' + l).join('\n');
      pre.appendChild(del);
    }
    if (item.newText) {
      const add = el('div', 'diff-add');
      add.textContent = item.newText.split('\n').map((l) => '+ ' + l).join('\n');
      pre.appendChild(add);
    }
    wrap.appendChild(pre);
    body.appendChild(wrap);
  } else if (item.type === 'terminal') {
    body.appendChild(el('pre', null, `[terminal ${item.terminalId || ''}]`));
  }
}

/* ----- plan ----- */

function renderPlan(entries) {
  const card = el('div', 'tool open');
  const head = el('div', 'tool-head');
  head.appendChild(el('span', 'tool-status'));
  head.appendChild(el('span', 'tool-title', 'Plan'));
  card.appendChild(head);
  const body = el('div', 'tool-body');
  for (const e of entries) {
    const icon = e.status === 'completed' ? '☑' : e.status === 'in_progress' ? '▶' : '☐';
    body.appendChild(el('div', null, `${icon} ${e.content ?? ''}`));
  }
  card.appendChild(body);
  chat().appendChild(card);
  maybeScroll();
}

/* ----- permissions ----- */

const PERMISSION_LABELS = {
  allow_once: ['Allow', 'allow'],
  allow_always: ['Always allow', 'allow'],
  reject_once: ['Reject', 'reject'],
  reject_always: ['Never allow', 'reject'],
};

function showPermissionRequest(id, params) {
  closeStream();
  const slot = $('#permission-slot');
  slot.innerHTML = '';
  const card = el('div', 'permission');
  const tc = params?.toolCall || {};
  card.appendChild(el('div', 'permission-title', 'Goose wants to run a tool'));
  card.appendChild(el('div', 'permission-sub', tc.title || tc.kind || ''));
  const opts = el('div', 'permission-options');
  for (const opt of params?.options || []) {
    const [label, cls] = PERMISSION_LABELS[opt.kind] || [opt.name || opt.optionId, ''];
    const btn = el('button', cls, label);
    btn.addEventListener('click', () => {
      respondToAgent(id, { outcome: { outcome: 'selected', optionId: opt.optionId } });
      card.classList.add('resolved');
      card.querySelector('.permission-title').textContent = `${label} — ${tc.title || ''}`;
      setTimeout(() => { if (card.parentNode) card.remove(); }, 4000);
    });
    opts.appendChild(btn);
  }
  card.appendChild(opts);
  slot.appendChild(card);
}

/* ------------------------------------------------------------------ */
/* composer                                                            */
/* ------------------------------------------------------------------ */

function setBusy(busy) {
  state.busy = busy;
  if (busy && !state.turnStartedAt) state.turnStartedAt = Date.now();
  if (!busy) state.turnStartedAt = 0;
  state.probe = 'idle';
  $('#btn-send').hidden = busy;
  $('#btn-stop').hidden = !busy;
  if (!busy) closeStream();
  updateTurnStatus();
}

function fmtDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

function oldestRunningTool() {
  let oldest = null;
  for (const t of state.tools.values()) {
    if (!t.running || !t.startedAt) continue;
    if (!oldest || t.startedAt < oldest.startedAt) oldest = t;
  }
  return oldest;
}

function hasStaleTool() {
  for (const t of state.tools.values()) if (t.stale) return true;
  return false;
}

function cancelTurn() {
  if (!state.sessionId) return;
  notify('session/cancel', { sessionId: state.sessionId });
  addSystemMessage('Cancel requested');
  for (const t of state.tools.values()) {
    if (!t.stale && !t.running) continue;
    t.stale = false;
    t.running = false;
    t.card.dataset.status = 'failed';
    t.elapsedEl.hidden = false;
    t.elapsedEl.textContent = 'cancelled';
  }
  updateTurnStatus();
}

// One line above the composer that says whether the turn is moving, silent,
// being probed, or reconnecting — so "slow" and "lost" don't look the same.
function updateTurnStatus() {
  const box = $('#turn-status');
  if (!box) return;
  const tool = oldestRunningTool();
  const stale = hasStaleTool();
  if (!state.busy && !tool && !stale) {    box.hidden = true;
    box.replaceChildren();
    return;
  }
  box.hidden = false;

  const quiet = state.lastActivity ? Date.now() - state.lastActivity : 0;
  const turnMs = state.turnStartedAt
    ? Date.now() - state.turnStartedAt
    : (tool ? Date.now() - tool.startedAt : 0);

  let text;
  if (state.probe === 'dead') text = 'no response — reconnecting…';
  else if (state.probe === 'checking') text = `no update for ${fmtDur(quiet)} — checking connection…`;
  else if (state.probe === 'alive') text = `server answered · working · ${fmtDur(turnMs)}`;
  else if (quiet >= STALL_MS) text = `quiet ${fmtDur(quiet)} — checking…`;
  else if (!state.busy && tool) text = `tool running · ${fmtDur(turnMs)}`;
  else if (!state.busy && stale) text = 'unfinished tool call from an earlier connection';
  else text = `working · ${fmtDur(turnMs)}`;

  const parts = [el('span', 'turn-text', text)];
  // after a reload mid-turn the Stop button is hidden; this is the way out
  if (!state.busy && (tool || stale)) {
    const cancel = el('button', 'turn-cancel', 'Cancel');
    cancel.addEventListener('click', cancelTurn);
    parts.push(cancel);
  }
  const longTool = tool && Date.now() - tool.startedAt >= 5 * 60 * 1000;
  box.classList.toggle('warn', Boolean(longTool || state.probe === 'dead'));
  box.replaceChildren(...parts);
}

setInterval(() => {
  for (const t of state.tools.values()) {
    if (!t.elapsedEl || !t.startedAt) continue;
    const ms = (t.endedAt ?? Date.now()) - t.startedAt;
    t.elapsedEl.textContent = fmtDur(ms);
    t.elapsedEl.classList.toggle('warn', ms >= 5 * 60 * 1000);
  }
  updateTurnStatus();
}, 1000);

async function sendPrompt() {
  const input = $('#input');
  const text = input.value.trim();
  if (!text || state.busy) return;
  if (!state.sessionId) await ensureSession();
  if (!state.sessionId) return;

  input.value = '';
  autoGrow();
  hideSlashMenu();

  // optimistic user bubble (the agent does not echo our prompt)
  closeStream();
  hideWelcome();
  const bubble = el('div', 'msg user', text);
  chat().appendChild(bubble);
  maybeScroll();

  setBusy(true);
  try {
    const result = await rpc('session/prompt', {
      sessionId: state.sessionId,
      prompt: [{ type: 'text', text }],
    });
    if (result?.stopReason && result.stopReason !== 'end_turn' && result.stopReason !== 'stop_sequence') {
      if (result.stopReason !== 'cancelled') addSystemMessage(`stopped: ${result.stopReason}`);
    }
  } catch (err) {
    // a stall already reported the reconnect; don't stack a second message
    if (!state.stalled) addSystemMessage(err.message, true);
  } finally {
    state.stalled = false;
    setBusy(false);
    refreshSessionTitle();
  }
}

function cancelPrompt() {
  if (!state.sessionId) return;
  notify('session/cancel', { sessionId: state.sessionId });
}

function autoGrow() {
  const input = $('#input');
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 132) + 'px';
}

/* ----- slash commands ----- */

function updateSlashMenu() {
  const input = $('#input');
  const menu = $('#slash-menu');
  const v = input.value;
  if (!v.startsWith('/') || v.includes(' ') || state.commands.length === 0) {
    hideSlashMenu();
    return;
  }
  const q = v.slice(1).toLowerCase();
  const matches = state.commands.filter((c) => c.name.toLowerCase().startsWith(q)).slice(0, 8);
  if (!matches.length) { hideSlashMenu(); return; }
  menu.innerHTML = '';
  for (const c of matches) {
    const item = el('div', 'slash-item');
    item.appendChild(el('span', 'slash-name', '/' + c.name));
    if (c.description) item.appendChild(el('span', 'slash-desc', c.description));
    item.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      input.value = '/' + c.name + ' ';
      input.focus();
      hideSlashMenu();
      autoGrow();
    });
    menu.appendChild(item);
  }
  menu.hidden = false;
}

function hideSlashMenu() {
  $('#slash-menu').hidden = true;
}

/* ------------------------------------------------------------------ */
/* drawer (session list)                                               */
/* ------------------------------------------------------------------ */

function openDrawer() {
  $('#drawer').classList.add('open');
  $('#drawer-backdrop').hidden = false;
  loadSessionList();
}

function closeDrawer() {
  $('#drawer').classList.remove('open');
  $('#drawer-backdrop').hidden = true;
}

async function loadSessionList() {
  const list = $('#session-list');
  const hasRows = [...list.children].some((c) => c.dataset && c.dataset.sessionId);
  if (!hasRows) {
    list.innerHTML = '';
    list.appendChild(el('div', 'msg system', 'Loading…'));
  }
  try {
    const { sessions } = await rpc('session/list', {}, { timeoutMs: 20000 });
    state.sessionList = sessions || [];
    renderSessionList();
  } catch (err) {
    if (!hasRows) {
      list.innerHTML = '';
      list.appendChild(el('div', 'msg system error', err.message));
    } else {
      console.warn('session list refresh failed', err);
    }
  }
}

// Incremental drawer render keyed by sessionId: the container is never
// rebuilt, so the scroll position survives refreshes; only rows whose
// content, order or selection changed are touched.
function renderSessionList() {
  const list = $('#session-list');
  const order = state.sessionList || [];
  if (!order.length) {
    list.innerHTML = '';
    list.appendChild(el('div', 'msg system', 'No sessions yet'));
    return;
  }
  for (const n of [...list.children]) {
    if (!n.dataset || !n.dataset.sessionId) n.remove();
  }
  const existing = new Map();
  for (const n of list.children) {
    if (n.dataset && n.dataset.sessionId) existing.set(n.dataset.sessionId, n);
  }
  let cursor = null;
  for (const s of order) {
    let item = existing.get(s.sessionId);
    if (item) {
      updateSessionItem(item, s);
    } else {
      item = el('div', 'session-item');
      item.dataset.sessionId = s.sessionId;
      buildSessionItem(item, s);
    }
    // keep DOM order in sync with the server order without rebuilding
    list.insertBefore(item, cursor ? cursor.nextSibling : list.firstChild);
    cursor = item;
  }
  for (const [id, node] of existing) {
    if (!order.some((s) => s.sessionId === id)) node.remove();
  }
}

function buildSessionItem(item, s) {
  const meta = el('div', 'session-meta');
  meta.appendChild(el('div', 'session-name', s.title || s.sessionId));
  meta.appendChild(el('div', 'session-sub', formatSessionSub(s)));
  item.replaceChildren(meta);
  item.classList.toggle('current', s.sessionId === state.sessionId);
  const del = el('button', 'session-del', '✕');
  del.title = 'Delete session';
  del.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm(`Delete "${s.title || s.sessionId}"?`)) return;
    del.disabled = true;
    del.textContent = '…';
    try {
      await rpc('session/delete', { sessionId: s.sessionId }, { timeoutMs: 20000 });
      item.remove(); // drop immediately; the refresh below reconciles the rest
      loadSessionList().catch(() => {});
      if (s.sessionId === state.sessionId) {
        state.sessionId = null;
        try {
          await newSession();
        } catch (err) {
          addSystemMessage(`New session after delete failed: ${err.message}`, true);
        }
      }
    } catch (err) {
      del.disabled = false;
      del.textContent = '✕';
      addSystemMessage(`Delete failed: ${err.message}`, true);
    }
  });
  item.appendChild(del);
  item.onclick = async () => {
    closeDrawer();
    if (s.sessionId === state.sessionId) return;
    try {
      await loadSession(s.sessionId);
    } catch (err) {
      addSystemMessage(`Load failed: ${err.message}`, true);
    }
  };
}

function formatSessionSub(s) {
  const when = s.updatedAt ? new Date(s.updatedAt).toLocaleString() : '';
  const count = s._meta?.messageCount ? ` · ${s._meta.messageCount} msgs` : '';
  return when + count;
}

function updateSessionItem(item, s) {
  const name = item.querySelector('.session-name');
  const sub = item.querySelector('.session-sub');
  const current = s.sessionId === state.sessionId;
  if (!name || !sub) { buildSessionItem(item, s); return; }
  if (name.textContent !== (s.title || s.sessionId)
      || sub.textContent !== formatSessionSub(s)
      || item.classList.contains('current') !== current) {
    buildSessionItem(item, s);
  }
}


/* ------------------------------------------------------------------ */
/* bottom sheet (mode / model / thinking)                              */
/* ------------------------------------------------------------------ */

function openConnSheet() {
  const options = $('#sheet-options');
  options.innerHTML = '';
  const wsState = !state.ws ? 'closed'
    : state.ws.readyState === WebSocket.OPEN ? 'open'
      : state.ws.readyState === WebSocket.CONNECTING ? 'connecting' : 'closed';
  const quiet = state.lastActivity ? `${fmtDur(Date.now() - state.lastActivity)} ago` : 'never';
  const probe = state.probe === 'alive' ? 'answered'
    : state.probe === 'dead' ? 'no answer'
      : state.probe === 'checking' ? 'checking…' : 'idle';
  const rows = [
    ['Socket', wsState],
    ['Last message', quiet],
    ['Liveness probe', probe],
    ['Session', state.sessionId || 'none'],
    ['Agent', `${state.agentInfo?.name ?? 'goose'} ${state.agentInfo?.version ?? ''}`.trim()],
    ['Origin', location.host],
  ];
  for (const [k, v] of rows) {
    const row = el('div', 'conn-row');
    row.appendChild(el('span', 'conn-key', k));
    row.appendChild(el('span', 'conn-val', v));
    options.appendChild(row);
  }
  const close = el('button', 'sheet-option', 'Close');
  close.addEventListener('click', closeSheet);
  options.appendChild(close);
  $('#sheet-title').textContent = 'Connection';
  $('#sheet').classList.add('open');
  $('#sheet-backdrop').hidden = false;
}

function openSheet() {
  const options = $('#sheet-options');
  options.innerHTML = '';

  if (state.modes?.availableModes?.length) {
    options.appendChild(el('h2', null, 'Mode'));
    for (const m of state.modes.availableModes) {
      const btn = el('button', 'sheet-option' + (m.id === state.modes.currentModeId ? ' selected' : ''));
      btn.dataset.cfg = 'mode';
      btn.dataset.value = m.id;
      btn.appendChild(el('span', null, m.name || m.id));
      if (m.description) btn.appendChild(el('span', 'desc', m.description));
      btn.addEventListener('click', async () => {
        try {
          await rpc('session/set_mode', { sessionId: state.sessionId, modeId: m.id });
          state.modes.currentModeId = m.id;
          renderModePill(m.id);
          highlightSheetSelection();
          sheetToast(`Mode: ${m.name || m.id}`);
        } catch (err) {
          addSystemMessage(`Set mode failed: ${err.message}`, true);
          const errRow = el('div', 'msg system error', `Set mode failed: ${err.message}`);
          options.insertBefore(errRow, options.firstChild);
        }
      });
      options.appendChild(btn);
    }
  }

  for (const cfg of state.configOptions || []) {
    if (cfg.id === 'provider') continue; // provider changes need credentials; keep to CLI
    if (cfg.id === 'mode') continue;     // already rendered from state.modes above
    if (!Array.isArray(cfg.options) || !cfg.options.length) continue;
    options.appendChild(el('h2', null, cfg.name || cfg.id));
    // sort models case-insensitively; keep semantic order for e.g. thinking effort
    const opts = cfg.id === 'model'
      ? [...cfg.options].sort((a, b) =>
          (a.name || a.value).localeCompare(b.name || b.value, undefined, { sensitivity: 'base' }))
      : cfg.options;
    for (const opt of opts) {
      const btn = el('button', 'sheet-option' + (opt.value === cfg.currentValue ? ' selected' : ''));
      btn.dataset.cfg = cfg.id;
      btn.dataset.value = opt.value;
      btn.appendChild(el('span', null, opt.name || opt.value));
      if (opt.description) btn.appendChild(el('span', 'desc', opt.description));
      btn.addEventListener('click', async () => {
        try {
          const r = await rpc('session/set_config_option', {
            sessionId: state.sessionId,
            configId: cfg.id,
            value: opt.value,
          });
          if (r?.configOptions) state.configOptions = r.configOptions;
          if (cfg.id === 'thinking_effort') store.set('thinkingEffort', opt.value);
          addSystemMessage(`${cfg.name || cfg.id}: ${opt.name || opt.value}`);
          highlightSheetSelection();
          sheetToast(`${cfg.name || cfg.id}: ${opt.name || opt.value}`);
        } catch (err) {
          addSystemMessage(`Set ${cfg.id} failed: ${err.message}`, true);
          const errRow = el('div', 'msg system error',
            `Set ${cfg.name || cfg.id} failed: ${err.message}`);
          options.insertBefore(errRow, options.firstChild);
        }
      });
      options.appendChild(btn);
    }
  }

  $('#sheet-title').textContent = 'Session settings';
  $('#sheet').classList.add('open');
  $('#sheet-backdrop').hidden = false;

  // extensions section (loads asynchronously)
  options.appendChild(el('h2', null, 'Extensions'));
  const extWrap = el('div');
  extWrap.appendChild(el('div', 'msg system', 'Loading…'));
  options.appendChild(extWrap);
  renderExtensions(extWrap);
}

const extName = (e) => e?.name ?? e?.server?.name ?? '(unnamed)';

async function renderExtensions(wrap) {
  try {
    const [sessRes, cfgRes] = await Promise.all([
      rpc('_goose/unstable/session/extensions/list', { sessionId: state.sessionId }, { timeoutMs: 20000 }),
      rpc('_goose/unstable/config/extensions/list', {}, { timeoutMs: 20000 }),
    ]);
    const active = new Set((sessRes.extensions || []).map(extName));
    const rows = new Map(); // name -> { ext, active }
    for (const entry of cfgRes.extensions || []) {
      const ext = entry.extension ?? entry;
      rows.set(extName(ext), { ext, active: false });
    }
    for (const ext of sessRes.extensions || []) {
      const name = extName(ext);
      const row = rows.get(name) ?? { ext, active: false };
      row.active = true;
      rows.set(name, row);
    }
    const sorted = [...rows.entries()].sort((a, b) =>
      a[0].localeCompare(b[0], undefined, { sensitivity: 'base' }));

    wrap.innerHTML = '';
    if (!sorted.length) {
      wrap.appendChild(el('div', 'msg system', 'No extensions configured'));
      return;
    }
    for (const [name, { ext, active }] of sorted) {
      const row = el('div', 'ext-row');
      const metaEl = el('div', 'ext-meta');
      const label = ext.display_name || ext.displayName || name;
      metaEl.appendChild(el('span', 'ext-name', label));
      metaEl.appendChild(el('span', 'ext-kind', ext.type || ''));
      if (ext.description) metaEl.appendChild(el('span', 'desc', ext.description));
      row.appendChild(metaEl);
      const tog = el('button', 'ext-toggle' + (active ? ' on' : ''), active ? 'On' : 'Off');
      tog.setAttribute('aria-pressed', String(active));
      tog.addEventListener('click', async () => {
        tog.disabled = true;
        try {
          if (active) {
            await rpc('_goose/unstable/session/extensions/remove', { sessionId: state.sessionId, name }, { timeoutMs: 30000 });
          } else {
            await rpc('_goose/unstable/session/extensions/add', { sessionId: state.sessionId, extension: ext }, { timeoutMs: 30000 });
          }
          await renderExtensions(wrap);
        } catch (err) {
          tog.disabled = false;
          addSystemMessage(`Extension ${active ? 'remove' : 'add'} failed: ${err.message}`, true);
        }
      });
      row.appendChild(tog);
      wrap.appendChild(row);
    }
  } catch (err) {
    wrap.innerHTML = '';
    wrap.appendChild(el('div', 'msg system error', `Extensions unavailable: ${err.message}`));
  }
}

// Keep the selection highlight in the open sheet in sync with the server state.
function highlightSheetSelection() {
  const buttons = document.querySelectorAll('#sheet-options .sheet-option');
  for (const b of buttons) {
    if (b.dataset.cfg === 'mode') {
      b.classList.toggle('selected', b.dataset.value === state.modes?.currentModeId);
    } else {
      const cfg = (state.configOptions || []).find((c) => c.id === b.dataset.cfg);
      b.classList.toggle('selected', !!cfg && b.dataset.value === cfg.currentValue);
    }
  }
}

// Transient confirmation inside the sheet so multi-step changes don't need
// the popup to close (and chat stays clean).
function sheetToast(text) {
  const options = $('#sheet-options');
  const prev = options.querySelector('.sheet-toast');
  if (prev) prev.remove();
  const t = el('div', 'msg system sheet-toast', text);
  options.insertBefore(t, options.firstChild);
}

function closeSheet() {
  $('#sheet').classList.remove('open');
  $('#sheet-backdrop').hidden = true;
}

/* ------------------------------------------------------------------ */
/* wire-up                                                             */
/* ------------------------------------------------------------------ */

function init() {
  renderTitle();

  // deployment config (default cwd for new sessions)
  fetch('/config.json')
    .then((r) => (r.ok ? r.json() : {}))
    .then((c) => {
      // goose rejects a relative cwd (-32602), so only accept an absolute one
      if (typeof c.cwd === 'string' && c.cwd.startsWith('/')) state.defaultCwd = c.cwd;
    })
    .catch(() => {})
    .finally(connect);

  const input = $('#input');
  input.addEventListener('input', () => { autoGrow(); updateSlashMenu(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendPrompt();
    }
  });

  $('#auth-form').addEventListener('submit', (e) => {
    e.preventDefault();
    let t = $('#auth-input').value.trim();
    // tolerate pasting the whole .env line or a quoted value
    if (t.includes('=')) t = t.split('=').pop();
    t = t.replace(/^['"]|['"]$/g, '').trim();
    if (!t) return;
    state.token = t;
    store.set('token', t);
    hideAuthForm();
    const hint = $('#welcome-hint');
    if (hint) hint.textContent = 'Connecting…';
    state.reconnects = 0;
    connect();
  });

  $('#btn-send').addEventListener('click', sendPrompt);
  $('#btn-stop').addEventListener('click', cancelPrompt);
  $('#btn-new').addEventListener('click', () => newSession().catch((e) => addSystemMessage(e.message, true)));
  $('#btn-sessions').addEventListener('click', openDrawer);
  $('#btn-close-drawer').addEventListener('click', closeDrawer);
  $('#btn-signout').addEventListener('click', () => {
    // forget the secret and start over: the welcome screen asks for it again
    store.del('token');
    location.reload();
  });
  $('#drawer-backdrop').addEventListener('click', closeDrawer);
  $('#mode-pill').addEventListener('click', openSheet);
  $('#conn-dot').addEventListener('click', openConnSheet);
  $('#sheet-backdrop').addEventListener('click', closeSheet);

  const c = chat();
  c.addEventListener('scroll', () => {
    state.pinned = c.scrollHeight - c.scrollTop - c.clientHeight < 80;
  });

  // keep the latest message visible when the iOS keyboard opens
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => maybeScroll());
  }

  if ('serviceWorker' in navigator) {
    // when a new service worker takes control, reload once to pick up fresh code
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading) return;
      reloading = true;
      location.reload();
    });
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}

init();
