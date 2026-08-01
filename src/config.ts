import { homedir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

export const BRAIN_HOME = process.env.CLAUDEBRAIN_HOME ?? path.join(homedir(), '.claude-brain');
export const PORT = Number(process.env.CLAUDEBRAIN_PORT ?? 4519);
export const HOST = '127.0.0.1';
export const SETTINGS_PATH =
  process.env.CLAUDEBRAIN_SETTINGS ?? path.join(homedir(), '.claude', 'settings.json');
export const LOGS_DIR = path.join(BRAIN_HOME, 'logs');
export const TOKEN_PATH = path.join(BRAIN_HOME, 'token');

// Sessions with no activity for this long are not replayed to a newly opened viewer.
export const REPLAY_WINDOW_MS = 12 * 60 * 60 * 1000;
export const REPLAY_MAX_EVENTS_PER_SESSION = 5000;

export function ensureDirs(): void {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

export function loadOrCreateToken(): string {
  ensureDirs();
  try {
    const existing = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
    if (existing) return existing;
  } catch {
    // fall through to create
  }
  const token = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(TOKEN_PATH, token + '\n', { mode: 0o600 });
  return token;
}
