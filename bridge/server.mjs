#!/usr/bin/env node
/**
 * goose-pwa bridge
 *
 * Bridges a browser to `goose acp` (JSON-RPC over stdio):
 *   - Browser -> bridge:  POST /api/send   (JSON-RPC message, request or response)
 *   - Bridge  -> browser: GET  /api/events (SSE stream of every message from goose)
 *
 * A single long-lived `goose acp` child process is shared by all clients.
 * Every message received from goose is appended to a ring buffer so clients
 * can reconnect and replay what they missed (?since=<seq>).
 *
 * Zero dependencies. Requires Node >= 18.
 *
 * Environment:
 *   PORT              listen port            (default 8787)
 *   HOST              listen address         (default 127.0.0.1)
 *   GOOSE_BIN         goose binary           (default "goose")
 *   GOOSE_CWD         default session cwd    (default: process cwd)
 *   GOOSE_PWA_TOKEN   if set, clients must send it as
 *                     "Authorization: Bearer <token>" or "?token=<token>"
 *   BUFFER_SIZE       replay buffer entries  (default 2000)
 */

import { spawn } from 'node:child_process';
import http from 'node:http';

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '127.0.0.1';
const GOOSE_BIN = process.env.GOOSE_BIN ?? 'goose';
const DEFAULT_CWD = process.env.GOOSE_CWD ?? process.cwd();
const TOKEN = process.env.GOOSE_PWA_TOKEN ?? null;
const BUFFER_SIZE = Number(process.env.BUFFER_SIZE ?? 2000);

const log = (...a) => console.log(new Date().toISOString(), '[bridge]', ...a);

/* ------------------------------------------------------------------ */
/* Replay buffer                                                       */
/* ------------------------------------------------------------------ */

let seq = 0;
let buffer = []; // { seq, msg }

function record(msg) {
  seq += 1;
  buffer.push({ seq, msg });
  if (buffer.length > BUFFER_SIZE) buffer = buffer.slice(-BUFFER_SIZE);
  return seq;
}

const oldestSeq = () => (buffer.length ? buffer[0].seq : seq + 1);

/* ------------------------------------------------------------------ */
/* goose acp child process                                             */
/* ------------------------------------------------------------------ */

const goose = {
  proc: null,
  state: 'down', // down | starting | ready
  epoch: 0, // bumped on every (re)start so clients can resync
  outbox: [], // queued client messages while not ready
  agentInfo: null,
  agentCapabilities: null,
  backoff: 1000,
  line: '',
};

function gooseStart() {
  if (goose.proc) return;
  goose.state = 'starting';
  goose.epoch += 1;
  log(`spawning "${GOOSE_BIN} acp" (epoch ${goose.epoch})`);

  const proc = spawn(GOOSE_BIN, ['acp'], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: process.env,
  });
  goose.proc = proc;
  goose.line = '';

  proc.stdout.on('data', (chunk) => {
    goose.line += chunk.toString('utf8');
    let idx;
    while ((idx = goose.line.indexOf('\n')) >= 0) {
      const line = goose.line.slice(0, idx).trim();
      goose.line = goose.line.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        log('non-JSON from goose:', line.slice(0, 200));
        continue;
      }
      handleGooseMessage(msg);
    }
  });

  proc.on('error', (err) => log('goose spawn error:', err.message));

  proc.on('exit', (code, signal) => {
    log(`goose exited (code=${code} signal=${signal})`);
    goose.proc = null;
    goose.state = 'down';
    goose.agentInfo = null;
    goose.agentCapabilities = null;
    broadcastState();
    setTimeout(() => {
      gooseStart();
    }, goose.backoff);
    goose.backoff = Math.min(goose.backoff * 2, 15000);
  });

  // Handshake, then flush the queue.
  sendToGoose({
    jsonrpc: '2.0',
    id: '__bridge_init__',
    method: 'initialize',
    params: {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: 'goose-pwa', version: '1.0.0' },
    },
  });
}

function handleGooseMessage(msg) {
  if (msg.id === '__bridge_init__') {
    if (msg.error) {
      log('initialize failed:', JSON.stringify(msg.error));
      goose.proc?.kill();
      return;
    }
    goose.agentInfo = msg.result?.agentInfo ?? null;
    goose.agentCapabilities = msg.result?.agentCapabilities ?? null;
    goose.state = 'ready';
    goose.backoff = 1000;
    log(`goose ready: ${goose.agentInfo?.name} ${goose.agentInfo?.version}`);
    broadcastState();
    const queued = goose.outbox;
    goose.outbox = [];
    for (const m of queued) sendToGoose(m);
    return;
  }
  record(msg);
  broadcast(msg);
}

function sendToGoose(msg) {
  if (!goose.proc || goose.state === 'down') return false;
  if (goose.state !== 'ready' && msg.id !== '__bridge_init__') {
    goose.outbox.push(msg);
    return true;
  }
  goose.proc.stdin.write(JSON.stringify(msg) + '\n');
  return true;
}

/* ------------------------------------------------------------------ */
/* SSE hub                                                             */
/* ------------------------------------------------------------------ */

const clients = new Set(); // http.ServerResponse

function sseWrite(res, event, data, id = null) {
  if (id !== null) res.write(`id: ${id}\n`);
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast(msg) {
  for (const res of clients) sseWrite(res, 'msg', msg, seq);
}

function broadcastState() {
  const state = {
    state: goose.state,
    epoch: goose.epoch,
    seq,
    oldestSeq: oldestSeq(),
    agentInfo: goose.agentInfo,
    defaultCwd: DEFAULT_CWD,
  };
  for (const res of clients) sseWrite(res, 'bridge', state);
}

setInterval(() => {
  for (const res of clients) res.write(': ka\n\n');
}, 15000);

/* ------------------------------------------------------------------ */
/* HTTP API                                                            */
/* ------------------------------------------------------------------ */

function authorized(req) {
  if (!TOKEN) return true;
  const url = new URL(req.url, 'http://x');
  const header = req.headers.authorization;
  return header === `Bearer ${TOKEN}` || url.searchParams.get('token') === TOKEN;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 5_000_000) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  if (!url.pathname.startsWith('/api/')) {
    res.writeHead(404).end('not found');
    return;
  }
  if (!authorized(req)) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }

  // --- SSE stream -------------------------------------------------
  if (req.method === 'GET' && url.pathname === '/api/events') {
    const sinceHeader = req.headers['last-event-id'];
    const since = Number(url.searchParams.get('since') ?? sinceHeader ?? 0);
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(': connected\n\n');

    const gap = since > 0 && since < oldestSeq() - 1;
    sseWrite(res, 'bridge', {
      state: goose.state,
      epoch: goose.epoch,
      seq,
      oldestSeq: oldestSeq(),
      gap, // true if the client missed messages that fell out of the buffer
      agentInfo: goose.agentInfo,
      defaultCwd: DEFAULT_CWD,
    });

    if (since > 0) {
      for (const entry of buffer) {
        if (entry.seq > since) sseWrite(res, 'msg', entry.msg, entry.seq);
      }
    }

    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  // --- Client -> goose --------------------------------------------
  if (req.method === 'POST' && url.pathname === '/api/send') {
    let msg;
    try {
      msg = JSON.parse(await readBody(req));
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid JSON' }));
      return;
    }
    if (typeof msg !== 'object' || msg === null || msg.jsonrpc !== '2.0') {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not a JSON-RPC message' }));
      return;
    }
    if (goose.state === 'down') {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'goose is not running' }));
      return;
    }
    sendToGoose(msg);
    res.writeHead(202, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // --- Health / info ----------------------------------------------
  if (req.method === 'GET' && url.pathname === '/api/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: goose.state === 'ready',
        state: goose.state,
        epoch: goose.epoch,
        agent: goose.agentInfo,
        uptime: process.uptime(),
      }),
    );
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'unknown endpoint' }));
});

server.listen(PORT, HOST, () => {
  log(`listening on http://${HOST}:${PORT} (token ${TOKEN ? 'required' : 'disabled'})`);
  gooseStart();
});
