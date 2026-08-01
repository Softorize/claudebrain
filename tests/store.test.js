import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CLAUDEBRAIN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-store-'));

const { EventStore } = await import('../dist/store.js');

const waitFor = async (predicate, ms = 2000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
};

test('append then loadRecentEvents round-trips across sessions', async () => {
  const store = new EventStore();
  const logDir = path.join(process.env.CLAUDEBRAIN_HOME, 'logs');
  store.append({ t: 3, sid: 'b', event: 'PreToolUse', cwd: '/x', data: { tool: 'Read' } });
  store.append({ t: 1, sid: 'a', event: 'SessionStart', cwd: '/x', data: {} });
  store.append({ t: 2, sid: 'a', event: 'Stop', cwd: '/x', data: {} });

  assert.ok(
    await waitFor(() => {
      try {
        return (
          fs.readFileSync(path.join(logDir, 'a.jsonl'), 'utf8').split('\n').filter(Boolean).length === 2 &&
          fs.existsSync(path.join(logDir, 'b.jsonl'))
        );
      } catch {
        return false;
      }
    }),
    'log files appear on disk',
  );

  const events = new EventStore().loadRecentEvents();
  assert.equal(events.length, 3);
  assert.deepEqual(
    events.map((e) => e.t),
    [1, 2, 3],
    'sorted oldest first',
  );
});

test('session ids are sanitized into safe filenames', async () => {
  const store = new EventStore();
  store.append({ t: 9, sid: '../../evil', event: 'Stop', cwd: '', data: {} });
  const logDir = path.join(process.env.CLAUDEBRAIN_HOME, 'logs');
  assert.ok(await waitFor(() => fs.readdirSync(logDir).some((f) => f.includes('evil'))));
  const names = fs.readdirSync(logDir);
  assert.ok(names.every((n) => !n.includes('..')), 'no traversal in filenames');
});

test('corrupt lines are skipped, valid ones survive', async () => {
  const logDir = path.join(process.env.CLAUDEBRAIN_HOME, 'logs');
  fs.writeFileSync(path.join(logDir, 'corrupt.jsonl'), 'not-json\n{"t":5,"sid":"corrupt","event":"Stop","cwd":"","data":{}}\n');
  const events = new EventStore().loadRecentEvents();
  assert.ok(events.some((e) => e.sid === 'corrupt' && e.t === 5));
});
