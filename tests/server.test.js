import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-server-'));
const PORT = 4970 + Math.floor(Math.random() * 20);
process.env.CLAUDEBRAIN_HOME = home;
process.env.CLAUDEBRAIN_PORT = String(PORT);

const { loadOrCreateToken } = await import('../dist/config.js');
const { startServer } = await import('../dist/server.js');
const { default: WebSocket } = await import('ws');

const token = loadOrCreateToken();
const server = await startServer(token);
after(() => server.close());

const base = `http://127.0.0.1:${PORT}`;
const hook = (event, payload, headers = {}) =>
  fetch(`${base}/api/hook?event=${event}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });

test('hook endpoint requires the token', async () => {
  const res = await hook('PreToolUse', {});
  assert.equal(res.status, 401);
});

test('authorized events are accepted, answered instantly, and persisted', async () => {
  const res = await hook(
    'PreToolUse',
    { session_id: 'srv1', cwd: '/tmp/p', tool_name: 'Read', tool_input: { file_path: '/tmp/p/a.ts' } },
    { 'X-Claudebrain-Token': token },
  );
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '{}', 'v1 always answers allow');

  const logFile = path.join(home, 'logs', 'srv1.jsonl');
  const start = Date.now();
  let line;
  while (line === undefined && Date.now() - start < 3000) {
    try {
      const txt = fs.readFileSync(logFile, 'utf8');
      // only parse once the async append has landed a complete line
      if (txt.endsWith('\n')) line = JSON.parse(txt.trim());
    } catch {
      // not there yet
    }
    if (line === undefined) await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(line, 'event was persisted within 3s');
  assert.equal(line.data.tool, 'Read');
});

test('large payloads are not dropped', async () => {
  const res = await hook(
    'PreToolUse',
    { session_id: 'srv-big', cwd: '/tmp/p', tool_name: 'Write', tool_input: { file_path: '/t/b.txt', content: 'x'.repeat(2 * 1024 * 1024) } },
    { 'X-Claudebrain-Token': token },
  );
  assert.equal(res.status, 200);
});

test('the page requires the token; static assets are served', async () => {
  assert.equal((await fetch(`${base}/`)).status, 401);
  assert.equal((await fetch(`${base}/?token=${token}`)).status, 200);
  assert.equal((await fetch(`${base}/health`)).status, 200);
});

test('upload: stores an image and returns its path; rejects non-images and bad tokens', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(
    (await fetch(`${base}/api/upload`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png }))
      .status,
    401,
  );
  assert.equal(
    (
      await fetch(`${base}/api/upload?token=${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: 'nope',
      })
    ).status,
    415,
  );

  const res = await fetch(`${base}/api/upload?token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: png,
  });
  assert.equal(res.status, 200);
  const { path: saved } = await res.json();
  assert.ok(path.isAbsolute(saved) && saved.endsWith('.png'));
  assert.deepEqual(fs.readFileSync(saved), png, 'bytes round-trip to disk');
  fs.rmSync(saved);
});

test('websocket: wrong token rejected, right token gets a replay', async () => {
  await new Promise((resolve, reject) => {
    const bad = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=nope`);
    bad.on('open', () => reject(new Error('bad token connected')));
    bad.on('error', () => resolve());
  });

  const replay = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${token}`);
    ws.on('message', (m) => {
      const d = JSON.parse(m.toString());
      if (d.type === 'replay') {
        ws.close();
        resolve(d);
      }
    });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('no replay within 3s')), 3000);
  });
  assert.ok(Array.isArray(replay.events));
  assert.ok(
    replay.events.some((e) => e.sid === 'srv1'),
    'replay contains previously ingested events',
  );
});
