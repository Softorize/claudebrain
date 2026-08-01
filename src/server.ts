import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
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

/**
 * Does a tmux pane_current_command look like Claude Code? The CLI sets its
 * process title to its bare version ("2.1.218"), so a pure version string is
 * the strongest signal; also accept claude/node/bun. Never plain shells.
 */
function looksLikeClaudePane(cmd: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(cmd) || /^claude/i.test(cmd) || cmd === 'node' || cmd === 'bun';
}

/**
 * Find the tmux pane whose Claude Code session lives in `cwd` and type the
 * prompt into it (literal keys, then Enter). Matching is by working directory
 * plus a foreground command that looks like Claude Code — never a plain shell,
 * so a prompt can't be typed into zsh and executed as a shell command.
 */
function sendPromptToTmux(cwd: string, text: string, cb: (err: string | null, panes?: number) => void): void {
  execFile(
    'tmux',
    ['list-panes', '-a', '-F', '#{pane_id}\t#{pane_current_command}\t#{pane_current_path}'],
    (err, stdout) => {
      if (err) {
        cb('tmux is not available or no tmux server is running');
        return;
      }
      // tmux reports resolved paths (/tmp → /private/tmp on macOS) — compare realpaths
      let resolvedCwd = cwd;
      try {
        resolvedCwd = fs.realpathSync(cwd);
      } catch {
        // keep as-is; the session's folder may be gone
      }
      const candidates = stdout
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [id, cmd, panePath] = line.split('\t');
          return { id, cmd, panePath };
        })
        .filter((p) => (p.panePath === cwd || p.panePath === resolvedCwd) && looksLikeClaudePane(p.cmd));
      if (candidates.length === 0) {
        cb('no tmux pane running Claude Code was found for this session’s folder');
        return;
      }
      const pane = candidates[0];
      execFile('tmux', ['send-keys', '-t', pane.id, '-l', text], (err2) => {
        if (err2) {
          cb('failed to type into the tmux pane');
          return;
        }
        execFile('tmux', ['send-keys', '-t', pane.id, 'Enter'], (err3) => {
          if (err3) cb('typed the prompt but failed to submit it');
          else cb(null, candidates.length);
        });
      });
    },
  );
}

export function startServer(token: string): Promise<BrainServer> {
  const store = new EventStore();
  const clients = new Set<WebSocket>();

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
        let body: { cwd?: string; text?: string } = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          // handled below
        }
        const cwd = String(body.cwd ?? '');
        const text = String(body.text ?? '')
          .replace(/[\r\n]+/g, ' ')
          .trim()
          .slice(0, 4000);
        if (!cwd || !text) {
          res.writeHead(400, { 'Content-Type': 'application/json' }).end('{"error":"cwd and text required"}');
          return;
        }
        sendPromptToTmux(cwd, text, (err, paneCount) => {
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
