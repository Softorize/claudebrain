// Fires a scripted sequence of synthetic hook events at a running claudebrain
// server so the graph can be exercised without a live Claude Code session.
import { HOST, PORT } from './config.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runDemo(token: string): Promise<void> {
  const sid = `demo-${Math.random().toString(36).slice(2, 8)}`;
  const cwd = '/Users/demo/acme-web';

  async function send(event: string, payload: Record<string, unknown>): Promise<void> {
    const res = await fetch(`http://${HOST}:${PORT}/api/hook?event=${event}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Claudebrain-Token': token },
      body: JSON.stringify({ session_id: sid, cwd, hook_event_name: event, ...payload }),
    });
    if (!res.ok) throw new Error(`server responded ${res.status} — is \`claudebrain start\` running?`);
  }

  const tool = async (name: string, input: Record<string, unknown>, opts?: { error?: boolean; ms?: number }) => {
    await send('PreToolUse', { tool_name: name, tool_input: input });
    await sleep(opts?.ms ?? 500);
    await send('PostToolUse', {
      tool_name: name,
      tool_input: input,
      tool_response: opts?.error ? { success: false } : { success: true },
    });
  };

  console.log(`demo session ${sid} — watch the graph`);
  await send('SessionStart', { source: 'startup' });
  await sleep(600);
  await send('UserPromptSubmit', { prompt: 'Fix the flaky auth test and clean up the login flow' });
  await sleep(700);

  await tool('Skill', { skill: 'karpathy-guidelines' }, { ms: 300 });
  await tool('Read', { file_path: `${cwd}/src/auth/login.ts` });
  await tool('Read', { file_path: `${cwd}/src/auth/session.ts` });
  await tool('Grep', { pattern: 'refreshToken' }, { ms: 350 });
  await tool('Read', { file_path: `${cwd}/tests/auth/login.test.ts` });
  await tool('Edit', { file_path: `${cwd}/src/auth/login.ts` });
  await tool('Bash', { command: 'npm test -- tests/auth' }, { ms: 1400, error: true });
  await tool('Read', { file_path: `${cwd}/src/auth/token.ts` });
  await tool('Edit', { file_path: `${cwd}/src/auth/token.ts` });
  await tool('Bash', { command: 'npm test -- tests/auth' }, { ms: 1400 });

  await send('PreToolUse', {
    tool_name: 'Task',
    tool_input: { description: 'Audit remaining auth callers', prompt: '...' },
  });
  await sleep(900);
  for (const f of ['src/api/client.ts', 'src/api/middleware.ts', 'src/pages/login.tsx']) {
    await tool('Read', { file_path: `${cwd}/${f}` }, { ms: 350 });
  }
  await send('SubagentStop', {});
  await send('PostToolUse', { tool_name: 'Task', tool_response: { success: true } });

  await tool('Bash', { command: 'git status' }, { ms: 300 });
  await send('Stop', {});
  console.log('demo turn 1 done — session is now “waiting for input”');
  await sleep(2500);

  await send('UserPromptSubmit', { prompt: 'looks good, commit it' });
  await tool('Bash', { command: 'git add -A' }, { ms: 300 });
  await tool('Bash', { command: 'git commit -m "fix flaky auth test"' }, { ms: 500 });
  await send('Stop', {});
  console.log('demo complete');
}
