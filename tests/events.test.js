import { test } from 'node:test';
import assert from 'node:assert/strict';

const { normalizeHookEvent } = await import('../dist/events.js');

test('PreToolUse carries tool name and truncated input', () => {
  const ev = normalizeHookEvent('PreToolUse', {
    session_id: 'sid1',
    cwd: '/tmp/proj',
    tool_name: 'Bash',
    tool_input: { command: 'x'.repeat(5000), run_in_background: true },
  });
  assert.equal(ev.sid, 'sid1');
  assert.equal(ev.event, 'PreToolUse');
  assert.equal(ev.data.tool, 'Bash');
  assert.ok(ev.data.input.command.length <= 2001, 'long strings are truncated');
  assert.equal(ev.data.input.run_in_background, true);
});

test('nested input objects are stringified, not dropped', () => {
  const ev = normalizeHookEvent('PreToolUse', {
    session_id: 's',
    cwd: '/x',
    tool_name: 'Edit',
    tool_input: { file_path: '/x/a.ts', meta: { deep: 1 } },
  });
  assert.equal(typeof ev.data.input.meta, 'string');
});

test('PostToolUse flags failures', () => {
  const bad = normalizeHookEvent('PostToolUse', {
    session_id: 's',
    cwd: '/x',
    tool_name: 'Bash',
    tool_response: { success: false },
  });
  assert.equal(bad.data.isError, true);
  const ok = normalizeHookEvent('PostToolUse', {
    session_id: 's',
    cwd: '/x',
    tool_name: 'Bash',
    tool_response: { success: true },
  });
  assert.equal(ok.data.isError, undefined);
});

test('UserPromptSubmit keeps the prompt, capped', () => {
  const ev = normalizeHookEvent('UserPromptSubmit', {
    session_id: 's',
    cwd: '/x',
    prompt: 'p'.repeat(5000),
  });
  assert.ok(ev.data.prompt.length <= 2001);
  assert.ok(ev.data.prompt.startsWith('ppp'));
});

test('unknown session id falls back safely', () => {
  const ev = normalizeHookEvent('Stop', {});
  assert.equal(ev.sid, 'unknown');
  assert.equal(ev.cwd, '');
});
