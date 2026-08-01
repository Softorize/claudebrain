import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { execFileSync } from 'node:child_process';
import { HOST, PORT, SETTINGS_PATH, TOKEN_PATH } from './config.js';

// Marker present in every command we install; uninstall matches on it.
const MARKER = '/api/hook?event=';

interface HookEntry {
  type: string;
  command: string;
  timeout?: number;
}

interface MatcherGroup {
  matcher?: string;
  hooks: HookEntry[];
}

// PreToolUse gets a long curl max-time so v2 breakpoints can hold the response
// open without ever touching settings.json again. --connect-timeout keeps the
// fail-open path instant when the viewer isn't running (loopback refusal is
// immediate). All other events use a short max-time.
const EVENTS: Array<{ name: string; matcher?: string; curlMaxTime: number; timeout: number }> = [
  { name: 'SessionStart', curlMaxTime: 2, timeout: 5 },
  { name: 'UserPromptSubmit', curlMaxTime: 2, timeout: 5 },
  { name: 'PreToolUse', matcher: '*', curlMaxTime: 300, timeout: 310 },
  { name: 'PostToolUse', matcher: '*', curlMaxTime: 2, timeout: 5 },
  { name: 'Notification', curlMaxTime: 2, timeout: 5 },
  { name: 'Stop', curlMaxTime: 2, timeout: 5 },
  { name: 'SubagentStop', curlMaxTime: 2, timeout: 5 },
  { name: 'SessionEnd', curlMaxTime: 2, timeout: 5 },
];

function hookCommand(event: string, curlMaxTime: number): string {
  return (
    `curl -s --connect-timeout 1 -m ${curlMaxTime} -X POST ` +
    `-H "Content-Type: application/json" ` +
    `-H "X-Claudebrain-Token: $(cat ${TOKEN_PATH} 2>/dev/null)" ` +
    `--data-binary @- "http://${HOST}:${PORT}${MARKER}${event}" 2>/dev/null || true`
  );
}

function isOurs(h: HookEntry): boolean {
  return typeof h.command === 'string' && h.command.includes(MARKER);
}

function readSettings(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
  } catch {
    return {};
  }
}

/** Remove claudebrain hooks from a settings object (mutates and returns it). */
function stripOurHooks(settings: Record<string, unknown>): Record<string, unknown> {
  const hooks = settings.hooks as Record<string, MatcherGroup[]> | undefined;
  if (!hooks) return settings;
  for (const event of Object.keys(hooks)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    const kept = groups
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurs(h)) }))
      .filter((g) => g.hooks.length > 0);
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }
  if (Object.keys(hooks).length === 0) delete settings.hooks;
  return settings;
}

function addOurHooks(settings: Record<string, unknown>): Record<string, unknown> {
  const hooks = (settings.hooks ?? {}) as Record<string, MatcherGroup[]>;
  settings.hooks = hooks;
  for (const ev of EVENTS) {
    const group: MatcherGroup = {
      ...(ev.matcher ? { matcher: ev.matcher } : {}),
      hooks: [{ type: 'command', command: hookCommand(ev.name, ev.curlMaxTime), timeout: ev.timeout }],
    };
    hooks[ev.name] = [...(hooks[ev.name] ?? []), group];
  }
  return settings;
}

function showDiff(before: Record<string, unknown>, after: Record<string, unknown>): boolean {
  const a = JSON.stringify(before, null, 2) + '\n';
  const b = JSON.stringify(after, null, 2) + '\n';
  if (a === b) return false;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudebrain-'));
  const fa = path.join(dir, 'settings.json.current');
  const fb = path.join(dir, 'settings.json.new');
  fs.writeFileSync(fa, a);
  fs.writeFileSync(fb, b);
  try {
    execFileSync('diff', ['-u', fa, fb], { stdio: 'inherit' });
  } catch {
    // diff exits 1 when files differ — that's the expected path
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
  rl.close();
  return answer === 'y' || answer === 'yes';
}

async function applyChange(
  after: Record<string, unknown>,
  before: Record<string, unknown>,
  yes: boolean,
  verb: string,
): Promise<void> {
  const changed = showDiff(before, after);
  if (!changed) {
    console.log(`Nothing to do — hooks already ${verb}ed.`);
    return;
  }
  if (!yes && !(await confirm(`Apply this change to ${SETTINGS_PATH}?`))) {
    console.log('Aborted, nothing written.');
    return;
  }
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  if (fs.existsSync(SETTINGS_PATH)) {
    fs.copyFileSync(SETTINGS_PATH, SETTINGS_PATH + '.claudebrain.bak');
  }
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(after, null, 2) + '\n');
  console.log(`Hooks ${verb}ed. (backup at ${SETTINGS_PATH}.claudebrain.bak)`);
  console.log('Note: only sessions started from now on will report events.');
}

export async function installHooks(yes: boolean): Promise<void> {
  const before = readSettings();
  const after = addOurHooks(stripOurHooks(structuredClone(before)));
  await applyChange(after, before, yes, 'install');
}

export async function uninstallHooks(yes: boolean): Promise<void> {
  const before = readSettings();
  const after = stripOurHooks(structuredClone(before));
  await applyChange(after, before, yes, 'uninstall');
}
