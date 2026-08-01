import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
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

export interface BrainServer {
  close(): void;
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
