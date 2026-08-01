// Normalizes raw Claude Code hook payloads into the compact event shape that is
// persisted to disk and broadcast to the viewer. Replay reads these same records.

export interface BrainEvent {
  t: number;
  sid: string;
  event: string;
  cwd: string;
  data: Record<string, unknown>;
}

// Long enough that real bash commands / file paths survive intact for the
// viewer's copy feature; still bounds pathological payloads (whole-file Writes).
const MAX_STRING = 2000;
const MAX_PROMPT = 2000;

function truncate(s: string, max = MAX_STRING): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/** Shallow-truncate long string values so logs and broadcasts stay small. */
function truncateValues(obj: unknown): Record<string, unknown> | undefined {
  if (obj === null || typeof obj !== 'object') return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = truncate(v);
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (v !== null && typeof v === 'object') out[k] = truncate(JSON.stringify(v));
  }
  return out;
}

const MAX_OUTPUT = 4000;

/** Best-effort human-readable text from a tool_response of any shape. */
function extractOutput(resp: unknown): string {
  if (resp === null || resp === undefined) return '';
  if (typeof resp === 'string') return resp;
  if (typeof resp !== 'object') return String(resp);
  const r = resp as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof r.stdout === 'string' && r.stdout.trim()) parts.push(r.stdout);
  if (typeof r.stderr === 'string' && r.stderr.trim()) parts.push(`[stderr] ${r.stderr}`);
  if (parts.length > 0) return parts.join('\n');
  for (const key of ['output', 'content', 'result', 'message', 'error']) {
    if (typeof r[key] === 'string' && (r[key] as string).trim()) return r[key] as string;
  }
  try {
    const s = JSON.stringify(r);
    return s === '{}' ? '' : s;
  } catch {
    return '';
  }
}

function looksLikeError(response: unknown): boolean {
  if (response === null || response === undefined) return false;
  if (typeof response === 'object') {
    const r = response as Record<string, unknown>;
    if (r.is_error === true || r.success === false || r.interrupted === true) return true;
  }
  return false;
}

export function normalizeHookEvent(eventName: string, payload: Record<string, unknown>): BrainEvent {
  const sid = String(payload.session_id ?? 'unknown');
  const cwd = String(payload.cwd ?? '');
  const data: Record<string, unknown> = {};

  switch (eventName) {
    case 'PreToolUse': {
      data.tool = String(payload.tool_name ?? '?');
      const input = truncateValues(payload.tool_input);
      if (input) data.input = input;
      break;
    }
    case 'PostToolUse': {
      data.tool = String(payload.tool_name ?? '?');
      if (looksLikeError(payload.tool_response)) data.isError = true;
      const output = extractOutput(payload.tool_response);
      if (output) data.output = truncate(output, MAX_OUTPUT);
      break;
    }
    case 'UserPromptSubmit':
      data.prompt = truncate(String(payload.prompt ?? ''), MAX_PROMPT);
      break;
    case 'Notification':
      data.message = truncate(String(payload.message ?? ''));
      break;
    case 'SessionStart':
      data.source = String(payload.source ?? '');
      break;
    default:
      break; // Stop, SubagentStop, SessionEnd carry no extra data
  }

  return { t: Date.now(), sid, event: eventName, cwd, data };
}
