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
  while (!fs.existsSync(logFile) && Date.now() - start < 2000) {
    await new Promise((r) => setTimeout(r, 25));
  }
  const line = JSON.parse(fs.readFileSync(logFile, 'utf8').trim());
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
