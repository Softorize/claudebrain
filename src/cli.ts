#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOST, PORT, SETTINGS_PATH, BRAIN_HOME, loadOrCreateToken } from './config.js';
import { installHooks, uninstallHooks } from './hooks.js';
import { startServer } from './server.js';
import { runDemo } from './demo.js';

const USAGE = `claudebrain — ambient live visualizer for Claude Code

Usage:
  claudebrain start [--no-open]   Start the viewer server and open the graph
  claudebrain install-hooks [--yes]    Add claudebrain hooks to ${SETTINGS_PATH}
  claudebrain uninstall-hooks [--yes]  Remove claudebrain hooks from ${SETTINGS_PATH}
  claudebrain demo                Fire a synthetic session at a running server
  claudebrain help                Show this help

Data & config live in ${BRAIN_HOME}`;

async function main(): Promise<void> {
  const [cmd = 'start', ...rest] = process.argv.slice(2);
  const flags = new Set(rest);

  switch (cmd) {
    case 'start': {
      const token = loadOrCreateToken();
      await startServer(token);
      const url = `http://${HOST}:${PORT}/?token=${token}`;
      console.log(`claudebrain listening on ${HOST}:${PORT}`);
      console.log(`viewer: ${url}`);
      if (!flags.has('--no-open') && process.platform === 'darwin') {
        spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
      }
      break;
    }
    case 'install-hooks':
      loadOrCreateToken(); // hooks read the token file — make sure it exists
      await installHooks(flags.has('--yes'));
      break;
    case 'uninstall-hooks':
      await uninstallHooks(flags.has('--yes'));
      break;
    case 'demo':
      await runDemo(loadOrCreateToken());
      break;
    case 'version':
    case '--version':
    case '-v': {
      const pkg = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
      console.log(JSON.parse(fs.readFileSync(pkg, 'utf8')).version);
      break;
    }
    case 'help':
    case '--help':
    case '-h':
      console.log(USAGE);
      break;
    default:
      console.error(`unknown command: ${cmd}\n`);
      console.log(USAGE);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
