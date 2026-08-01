import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { HOST, PORT } from './config.js';
import { normalizeHookEvent, type BrainEvent } from './events.js';
import { EventStore } from './store.js';

const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'web');
// Large enough for tool_input carrying whole file contents (Write/Edit);
// events.ts truncates strings downstream, so this only bounds transient buffering.
const MAX_BODY = 16 * 1024 * 1024;

const STATIC_FILES: Record<string, { file: string; type: string }> = {
  '/app.js': { file: 'app.js', type: 'text/javascript' },
  '/style.css': { file: 'style.css', type: 'text/css' },
};

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

export interface BrainServer {
  close(): void;
}

// Resolve tmux without relying on PATH — launchd services (brew services)
// run with a minimal PATH that lacks /opt/homebrew/bin.
const TMUX_CANDIDATES = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'];
let tmuxBin: string | undefined;
function tmuxPath(): string {
  tmuxBin ??= TMUX_CANDIDATES.find((p) => fs.existsSync(p)) ?? 'tmux';
  return tmuxBin;
}

// The user's tmux server socket can live under several temp dirs depending on
// the environment tmux was started from ($TMUX_TMPDIR, $TMPDIR, /tmp,
// DARWIN_USER_TEMP_DIR) — and a launchd service's TMPDIR often disagrees with
// the interactive one. Find the socket that actually exists; prefer the most
// recently created. Resolved per request so tmux restarts are picked up.
let darwinTempDir: string | null | undefined;
function findTmuxSocket(): string[] {
  const uid = typeof process.getuid === 'function' ? process.getuid() : '';
  if (darwinTempDir === undefined) {
    try {
      darwinTempDir = execFileSync('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR']).toString().trim() || null;
    } catch {
      darwinTempDir = null;
    }
  }
  const dirs = [process.env.TMUX_TMPDIR, process.env.TMPDIR, '/tmp', '/private/tmp', darwinTempDir];
  const seen = new Set<string>();
  const socks: string[] = [];
  for (const d of dirs) {
    if (!d) continue;
    const sock = path.join(d, `tmux-${uid}`, 'default');
    if (seen.has(sock)) continue;
    seen.add(sock);
    if (fs.existsSync(sock)) socks.push(sock);
  }
  if (socks.length === 0) return [];
  socks.sort((a, b) => {
    try {
      return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
    } catch {
      return 0;
    }
  });
  return ['-S', socks[0]];
}

/**
 * Does a tmux pane_current_command look like Claude Code? The CLI sets its
 * process title to its bare version ("2.1.218"), so a pure version string is
 * the strongest signal; also accept claude/node/bun. Never plain shells.
 */
function looksLikeClaudePane(cmd: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(cmd) || /^claude/i.test(cmd) || cmd === 'node' || cmd === 'bun';
}

/**
 * Type a prompt into the tmux pane hosting a Claude Code session.
 *
 * Preferred routing: the exact pane id the session's own hooks reported via
 * $TMUX_PANE — unambiguous even with several sessions in one folder. Fallback:
 * match by working directory plus a foreground command that looks like Claude
 * Code — never a plain shell, so a prompt can't be executed as a shell command.
 */
function sendPromptToTmux(
  cwd: string,
  text: string,
  knownPane: string | null,
  claimedByOthers: Set<string>,
  cb: (err: string | null, panes?: number) => void,
): void {
  const sock = findTmuxSocket();
  // NOTE: no control characters in the format — modern tmux sanitizes them
  // to '_' in list output; '|' with the path last parses unambiguously.
  execFile(
    tmuxPath(),
    [...sock, 'list-panes', '-a', '-F', '#{pane_id}|#{pane_current_command}|#{pane_current_path}'],
    (err, stdout) => {
      if (err) {
        cb('tmux is not available or no tmux server is running');
        return;
      }
      const panes = stdout
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const parts = line.split('|');
          return { id: parts[0], cmd: parts[1], panePath: parts.slice(2).join('|') };
        });

      let target = knownPane ? panes.find((p) => p.id === knownPane) : undefined;
      let matched = target ? 1 : 0;
      if (!target) {
        // tmux reports resolved paths (/tmp → /private/tmp on macOS)
        let resolvedCwd = cwd;
        try {
          resolvedCwd = fs.realpathSync(cwd);
        } catch {
          // keep as-is; the session's folder may be gone
        }
        let candidates = panes.filter(
          (p) => (p.panePath === cwd || p.panePath === resolvedCwd) && looksLikeClaudePane(p.cmd),
        );
        // panes known to host OTHER sessions can't be this one's pane
        const unclaimed = candidates.filter((p) => !claimedByOthers.has(p.id));
        if (unclaimed.length > 0) candidates = unclaimed;
        target = candidates[0];
        matched = candidates.length;
      }
      if (!target) {
        cb('no tmux pane running Claude Code was found for this session’s folder');
        return;
      }
      execFile(tmuxPath(), [...sock, 'send-keys', '-t', target.id, '-l', text], (err2) => {
        if (err2) {
          cb('failed to type into the tmux pane');
          return;
        }
        execFile(tmuxPath(), [...sock, 'send-keys', '-t', target.id, 'Enter'], (err3) => {
          if (err3) cb('typed the prompt but failed to submit it');
          else cb(null, matched);
        });
      });
    },
  );
}

export function startServer(token: string): Promise<BrainServer> {
  const store = new EventStore();
  const clients = new Set<WebSocket>();
  // sid → tmux pane id, learned from the X-Claudebrain-Pane hook header
  const panesBySid = new Map<string, string>();

  function broadcast(msg: object): void {
    const s = JSON.stringify(msg);
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(s);
    }
  }

  function authorized(req: http.IncomingMessage, url: URL): boolean {
    const header = req.headers['x-claudebrain-token'];
    return header === token || url.searchParams.get('token') === token;
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);

    if (req.method === 'POST' && url.pathname === '/api/hook') {
      if (!authorized(req, url)) {
        res.writeHead(401).end();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) req.destroy();
        else chunks.push(c);
      });
      req.on('end', () => {
        let payload: Record<string, unknown> = {};
        try {
          payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          // empty or malformed body — still record the event name
        }
        const eventName = url.searchParams.get('event') ?? String(payload.hook_event_name ?? '?');
        const ev = normalizeHookEvent(eventName, payload);
        const pane = req.headers['x-claudebrain-pane'];
        if (typeof pane === 'string' && /^%\d+$/.test(pane)) {
          panesBySid.set(ev.sid, pane);
          ev.data.pane = pane; // persisted, so the mapping survives restarts
        }
        store.append(ev);
        broadcast({ type: 'event', event: ev });
        // v1 always allows immediately. The request/response shape exists so v2
        // breakpoints can hold this response open and return a decision.
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
      });
      return;
    }

    // Type a prompt into the tmux pane running the session's Claude Code.
    if (req.method === 'POST' && url.pathname === '/api/prompt') {
      if (!authorized(req, url)) {
        res.writeHead(401).end();
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        let body: { sid?: string; cwd?: string; text?: string } = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          // handled below
        }
        const sid = String(body.sid ?? '');
        const cwd = String(body.cwd ?? '');
        const text = String(body.text ?? '')
          .replace(/[\r\n]+/g, ' ')
          .trim()
          .slice(0, 4000);
        if (!cwd || !text) {
          res.writeHead(400, { 'Content-Type': 'application/json' }).end('{"error":"cwd and text required"}');
          return;
        }
        const knownPane = (sid && panesBySid.get(sid)) || (sid && store.lastPaneFor(sid)) || null;
        const claimedByOthers = new Set<string>();
        for (const [otherSid, otherPane] of panesBySid) {
          if (otherSid !== sid) claimedByOthers.add(otherPane);
        }
        sendPromptToTmux(cwd, text, knownPane, claimedByOthers, (err, paneCount) => {
          if (err) {
            res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: err }));
          } else {
            res
              .writeHead(200, { 'Content-Type': 'application/json' })
              .end(JSON.stringify({ ok: true, panes: paneCount }));
          }
        });
      });
      return;
    }

    // Remove a session: delete its log and tell every viewer to drop it.
    if (req.method === 'DELETE' && url.pathname === '/api/session') {
      if (!authorized(req, url)) {
        res.writeHead(401).end();
        return;
      }
      const sid = url.searchParams.get('sid') ?? '';
      if (!sid) {
        res.writeHead(400).end();
        return;
      }
      store.removeSession(sid);
      broadcast({ type: 'session-removed', sid });
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
      return;
    }

    // Serve local image files for hover previews (viewer-authenticated only).
    if (req.method === 'GET' && url.pathname === '/api/file') {
      if (!authorized(req, url)) {
        res.writeHead(401).end();
        return;
      }
      const p = url.searchParams.get('path') ?? '';
      const mime = IMAGE_MIME[path.extname(p).toLowerCase()];
      if (!path.isAbsolute(p) || !mime) {
        res.writeHead(403).end();
        return;
      }
      fs.stat(p, (err, st) => {
        if (err || !st.isFile() || st.size > 25 * 1024 * 1024) {
          res.writeHead(404).end();
          return;
        }
        fs.readFile(p, (err2, data) => {
          if (err2) res.writeHead(404).end();
          else res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' }).end(data);
        });
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/favicon.ico') {
      res.writeHead(204).end();
      return;
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
      return;
    }

    if (req.method === 'GET' && url.pathname === '/') {
      if (!authorized(req, url)) {
        res.writeHead(401, { 'Content-Type': 'text/plain' });
        res.end('claudebrain: missing or bad token. Start via `claudebrain start` and use the printed URL.');
        return;
      }
      serveFile(res, 'index.html', 'text/html');
      return;
    }

    const asset = req.method === 'GET' ? STATIC_FILES[url.pathname] : undefined;
    if (asset) {
      serveFile(res, asset.file, asset.type);
      return;
    }

    res.writeHead(404).end();
  });

  function serveFile(res: http.ServerResponse, name: string, type: string): void {
    fs.readFile(path.join(WEB_DIR, name), (err, data) => {
      if (err) {
        res.writeHead(500).end(`missing ${name} — run \`npm run build\``);
      } else {
        res.writeHead(200, { 'Content-Type': type }).end(data);
      }
    });
  }

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
    if (url.pathname !== '/ws' || url.searchParams.get('token') !== token) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.add(ws);
      ws.on('close', () => clients.delete(ws));
      const events: BrainEvent[] = store.loadRecentEvents();
      ws.send(JSON.stringify({ type: 'replay', events }));
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, HOST, () => {
      resolve({
        close: () => {
          for (const ws of clients) ws.terminate();
          server.closeAllConnections();
          server.close();
        },
      });
    });
  });
}
