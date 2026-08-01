import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-hooks-'));
process.env.CLAUDEBRAIN_HOME = home;
process.env.CLAUDEBRAIN_SETTINGS = path.join(home, 'settings.json');

const { installHooks, uninstallHooks } = await import('../dist/hooks.js');

const ORIGINAL = {
  model: 'opus',
  hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }],
  },
};

test('install merges without touching foreign hooks; uninstall restores exactly', async () => {
  fs.writeFileSync(process.env.CLAUDEBRAIN_SETTINGS, JSON.stringify(ORIGINAL, null, 2));

  await installHooks(true);
  const installed = JSON.parse(fs.readFileSync(process.env.CLAUDEBRAIN_SETTINGS, 'utf8'));

  assert.equal(installed.model, 'opus', 'unrelated settings preserved');
  for (const event of [
    'SessionStart',
    'UserPromptSubmit',
    'PreToolUse',
    'PostToolUse',
    'Notification',
    'Stop',
    'SubagentStop',
    'SessionEnd',
  ]) {
    const groups = installed.hooks[event];
    assert.ok(Array.isArray(groups) && groups.length > 0, `${event} installed`);
  }
  const pre = installed.hooks.PreToolUse;
  assert.ok(
    pre.some((g) => g.hooks.some((h) => h.command === 'echo mine')),
    'foreign hook survives install',
  );
  assert.ok(
    pre.some((g) => g.hooks.some((h) => h.command.includes('/api/hook?event=PreToolUse'))),
    'our hook present',
  );

  // reinstall is idempotent
  await installHooks(true);
  const again = JSON.parse(fs.readFileSync(process.env.CLAUDEBRAIN_SETTINGS, 'utf8'));
  assert.equal(again.hooks.PreToolUse.length, pre.length, 'no duplicate groups on reinstall');

  await uninstallHooks(true);
  const restored = JSON.parse(fs.readFileSync(process.env.CLAUDEBRAIN_SETTINGS, 'utf8'));
  assert.deepEqual(restored, ORIGINAL, 'uninstall restores the original settings');
});

test('PreToolUse hook holds a long curl timeout for future breakpoints, others stay short', async () => {
  fs.writeFileSync(process.env.CLAUDEBRAIN_SETTINGS, '{}');
  await installHooks(true);
  const s = JSON.parse(fs.readFileSync(process.env.CLAUDEBRAIN_SETTINGS, 'utf8'));
  const cmd = (event) => s.hooks[event][0].hooks[0].command;
  assert.match(cmd('PreToolUse'), /-m 300\b/);
  assert.match(cmd('Stop'), /-m 2\b/);
  assert.match(cmd('PreToolUse'), /--connect-timeout 1\b/, 'fail-open stays instant');
  assert.match(cmd('PreToolUse'), /\|\| true$/, 'never blocks Claude Code');
});
