// ClaudeBrain — macOS shell around the claudebrain server + viewer.
//
// The app embeds the compiled claudebrain engine (synced from ../dist into
// engine/ by scripts/sync-engine.sh) and runs the server in-process. If a
// claudebrain server is already listening on the port (CLI or brew service),
// the app reuses it instead of starting a second one, so both entry points
// coexist. All state lives in ~/.claude-brain either way.
const { app, BrowserWindow, Menu, dialog, shell, clipboard } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const { pathToFileURL } = require('node:url');

const HOST = '127.0.0.1';
const PORT = Number(process.env.CLAUDEBRAIN_PORT ?? 4519);
const BRAIN_HOME = process.env.CLAUDEBRAIN_HOME ?? path.join(os.homedir(), '.claude-brain');
const TOKEN_PATH = path.join(BRAIN_HOME, 'token');
const SETTINGS_PATH =
  process.env.CLAUDEBRAIN_SETTINGS ?? path.join(os.homedir(), '.claude', 'settings.json');
// Marker the engine writes into every hook command; presence = hooks installed.
const HOOK_MARKER = '/api/hook?event=';

let win = null;
let token = '';
let brainServer = null; // set only when THIS process started the server
let engine = null;
// True once startup (server + first window) finished. second-instance and
// activate can fire while ensureServer() is still awaiting; creating a window
// then would load viewerURL() with an empty token and strand a 401 page.
let uiReady = false;

// The engine is ESM (claudebrain compiles with "type": "module"); this file is
// CJS like the rest of the Electron shell, so it loads the engine dynamically.
async function loadEngine() {
  if (!engine) {
    const dir = path.join(__dirname, 'engine');
    const mod = (name) => import(pathToFileURL(path.join(dir, name)).href);
    const [config, server, hooks, demo] = await Promise.all([
      mod('config.js'),
      mod('server.js'),
      mod('hooks.js'),
      mod('demo.js'),
    ]);
    engine = { config, server, hooks, demo };
  }
  return engine;
}

function healthCheck() {
  return new Promise((resolve) => {
    const req = http.get({ host: HOST, port: PORT, path: '/health', timeout: 800 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

function readTokenFile() {
  try {
    return fs.readFileSync(TOKEN_PATH, 'utf8').trim();
  } catch {
    return '';
  }
}

// Returns the viewer token. Starts the in-process server unless one is
// already running (then its token file is reused).
async function ensureServer() {
  if (await healthCheck()) {
    const t = readTokenFile();
    if (t) return t;
    throw new Error(
      `A claudebrain server is already running on ${HOST}:${PORT}, but its token file ` +
        `(${TOKEN_PATH}) is missing or empty. Stop that server and relaunch ClaudeBrain.`,
    );
  }
  const { config, server } = await loadEngine();
  const t = config.loadOrCreateToken();
  try {
    brainServer = await server.startServer(t);
  } catch (err) {
    // Lost the race against a CLI instance starting at the same moment — reuse it.
    if (err && err.code === 'EADDRINUSE' && (await healthCheck())) {
      const existing = readTokenFile();
      if (existing) return existing;
    }
    throw err;
  }
  return t;
}

function viewerURL() {
  return `http://${HOST}:${PORT}/?token=${token}`;
}

function hooksInstalled() {
  try {
    return fs.readFileSync(SETTINGS_PATH, 'utf8').includes(HOOK_MARKER);
  } catch {
    return false;
  }
}

// installHooks(true)/uninstallHooks(true) are the engine's non-interactive
// path: no readline prompt, settings.json backed up first. Their console/diff
// output just goes to the app log.
async function installHooks() {
  const { config, hooks } = await loadEngine();
  config.loadOrCreateToken(); // hook commands read the token file — make sure it exists
  await hooks.installHooks(true);
}

async function offerHookInstall() {
  if (hooksInstalled()) return;
  // "Not Now" is deliberately the default button: installing rewrites
  // ~/.claude/settings.json, and a default-button press can arrive without a
  // human (Enter key, dialog-autoclick watchdogs on machines running
  // unattended agents). The choice that can fire on its own must be the safe
  // one; installing stays one intentional click away, here or in the Server
  // menu.
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    message: 'Install Claude Code hooks?',
    detail:
      `ClaudeBrain watches your Claude Code sessions through hooks in ` +
      `${SETTINGS_PATH} — without them the graph stays empty. Your current ` +
      `settings are backed up first, and the hooks are fire-safe: when ` +
      `ClaudeBrain isn't running they exit in ~30 ms.\n\n` +
      `Only sessions started after installing will show up.`,
    buttons: ['Install Hooks', 'Not Now'],
    defaultId: 1,
    cancelId: 1,
  });
  if (response === 0) {
    try {
      await installHooks();
    } catch (err) {
      dialog.showErrorBox('Hook install failed', String((err && err.message) || err));
    }
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#07090e', // same as the viewer's page background
    title: 'ClaudeBrain',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadURL(viewerURL());

  // The viewer is a single page; anything trying to leave it (or open a new
  // window) goes to the system browser instead of navigating the shell.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== viewerURL()) {
      event.preventDefault();
      if (/^https?:/i.test(url) && !url.startsWith(`http://${HOST}:${PORT}`)) {
        shell.openExternal(url);
      }
    }
  });

  win.on('closed', () => {
    win = null;
  });
}

function buildMenu() {
  const template = [
    { role: 'appMenu' },
    {
      label: 'Server',
      submenu: [
        {
          label: 'Open Viewer in Browser',
          click: () => shell.openExternal(viewerURL()),
        },
        {
          label: 'Copy Viewer URL',
          click: () => clipboard.writeText(viewerURL()),
        },
        { type: 'separator' },
        {
          label: 'Fire Demo Session',
          click: async () => {
            try {
              const { demo } = await loadEngine();
              await demo.runDemo(token);
            } catch (err) {
              dialog.showErrorBox('Demo failed', String((err && err.message) || err));
            }
          },
        },
        { type: 'separator' },
        {
          label: 'Install Claude Code Hooks',
          click: async () => {
            try {
              await installHooks();
              dialog.showMessageBox(win, {
                message: 'Claude Code hooks are installed.',
                detail: 'Sessions started from now on will appear in the graph.',
              });
            } catch (err) {
              dialog.showErrorBox('Hook install failed', String((err && err.message) || err));
            }
          },
        },
        {
          label: 'Uninstall Claude Code Hooks',
          click: async () => {
            const { response } = await dialog.showMessageBox(win, {
              type: 'question',
              message: 'Remove ClaudeBrain hooks from Claude Code settings?',
              buttons: ['Uninstall', 'Cancel'],
              defaultId: 1,
              cancelId: 1,
            });
            if (response !== 0) return;
            try {
              const { hooks } = await loadEngine();
              await hooks.uninstallHooks(true);
            } catch (err) {
              dialog.showErrorBox('Hook uninstall failed', String((err && err.message) || err));
            }
          },
        },
        { type: 'separator' },
        {
          label: 'Open Data Folder',
          click: () => shell.openPath(BRAIN_HOME),
        },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    } else if (uiReady) {
      createWindow();
    }
    // else: startup is still in flight and will create the window itself
  });

  app.whenReady().then(async () => {
    try {
      token = await ensureServer();
    } catch (err) {
      dialog.showErrorBox('ClaudeBrain could not start', String((err && err.message) || err));
      app.quit();
      return;
    }
    buildMenu();
    createWindow();
    uiReady = true;
    offerHookInstall();
  });

  // Closing the window keeps the app (and the server, so hooks keep logging)
  // alive in the dock — standard macOS behavior; Cmd+Q quits for real.
  app.on('window-all-closed', () => {
    // no-op on purpose
  });

  app.on('activate', () => {
    if (!win && uiReady) createWindow();
  });

  app.on('will-quit', () => {
    if (brainServer) brainServer.close();
  });
}
