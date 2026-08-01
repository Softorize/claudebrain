import fs from 'node:fs';
import path from 'node:path';
import {
  LOGS_DIR,
  ensureDirs,
  REPLAY_WINDOW_MS,
  REPLAY_MAX_EVENTS_PER_SESSION,
} from './config.js';
import type { BrainEvent } from './events.js';

export class EventStore {
  constructor() {
    ensureDirs();
  }

  private logPath(sid: string): string {
    // Session ids come from Claude Code (uuids), but sanitize defensively.
    const safe = sid.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(LOGS_DIR, `${safe}.jsonl`);
  }

  append(ev: BrainEvent): void {
    fs.appendFile(this.logPath(ev.sid), JSON.stringify(ev) + '\n', () => {});
  }

  removeSession(sid: string): void {
    fs.rm(this.logPath(sid), { force: true }, () => {});
  }

  /** Most recent tmux pane id this session's hooks reported, if any. */
  lastPaneFor(sid: string): string | null {
    let raw: string;
    try {
      raw = fs.readFileSync(this.logPath(sid), 'utf8');
    } catch {
      return null;
    }
    const lines = raw.split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const ev = JSON.parse(lines[i]);
        if (typeof ev?.data?.pane === 'string') return ev.data.pane;
      } catch {
        // skip corrupt line
      }
    }
    return null;
  }

  /**
   * Events for all sessions active within the replay window, oldest first.
   * Recency comes from log file mtime, so nothing is lost on abrupt shutdown.
   */
  loadRecentEvents(): BrainEvent[] {
    const cutoff = Date.now() - REPLAY_WINDOW_MS;
    const events: BrainEvent[] = [];
    let names: string[];
    try {
      names = fs.readdirSync(LOGS_DIR).filter((n) => n.endsWith('.jsonl'));
    } catch {
      return events;
    }
    for (const name of names) {
      const file = path.join(LOGS_DIR, name);
      let raw: string;
      try {
        if (fs.statSync(file).mtimeMs < cutoff) continue;
        raw = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const lines = raw.split('\n').filter(Boolean);
      for (const line of lines.slice(-REPLAY_MAX_EVENTS_PER_SESSION)) {
        try {
          events.push(JSON.parse(line));
        } catch {
          // skip corrupt line
        }
      }
    }
    events.sort((a, b) => a.t - b.t);
    return events;
  }
}
