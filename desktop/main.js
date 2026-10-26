// Critique desktop app: runs the local server, keeps a menu bar item with your count and a native menu
// of the PRs that need you, shows macOS notifications, and opens the dashboard in its own window.
//
// If a Critique server is already running on the configured port (e.g. `npm start`), the app uses it
// instead of starting another.
//
// Other launchers can open the same menu with the critique://menu URL, and SketchyBar gets a
// critique_update event whenever the count changes (see integrations/sketchybar).

import { app, BrowserWindow, Menu, Notification, Tray, clipboard, nativeImage, screen, shell } from 'electron';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { menuModel } from '../lib/menu-model.js';
import { loadSettings } from '../lib/store.js';

const ASSETS = join(import.meta.dirname, 'assets');
const PRELOAD = join(import.meta.dirname, 'preload.cjs');
const port = Number(process.env.PORT) || loadSettings().port;
// Windows use localhost (matching browser tabs); the main process talks to 127.0.0.1 directly.
const appUrl = `http://localhost:${port}/`;
const apiUrl = `http://127.0.0.1:${port}/`;

let tray = null;
let trayMenu = null;
let pendingUrl = null;
let launchedByUrl = false;
let mainWindow = null;
let lastView = null;
let quitting = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const icon = (name) => nativeImage.createFromPath(join(ASSETS, `${name}.png`));

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => showMainWindow());
app.on('before-quit', () => (quitting = true));
app.on('window-all-closed', () => {}); // keep running in the menu bar
app.on('activate', () => showMainWindow()); // Dock icon clicked
app.on('open-url', (e, url) => {
  e.preventDefault();
  if (!app.isReady()) launchedByUrl = true;
  if (lastView) handleUrl(url);
  else pendingUrl = url; // handled once the first data arrives
});

// --- Server ---

async function isCritiqueRunning() {
  try {
    const res = await fetch(`${apiUrl}api/data`, { signal: AbortSignal.timeout(1500) });
    return res.ok && 'needsAttention' in (await res.json());
  } catch {
    return false;
  }
}

async function ensureServer() {
  if (await isCritiqueRunning()) return;
  await import('../server.js'); // starts listening on import
  for (let i = 0; i < 100 && !(await isCritiqueRunning()); i++) await sleep(100);
}

async function post(path, body = {}) {
  await fetch(`${apiUrl}${path.replace(/^\//, '')}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => {});
}

// Follow the server's live updates (the same stream the dashboard uses), reconnecting if it drops.
async function watchServer() {
  for (;;) {
    try {
      const res = await fetch(`${apiUrl}api/events`);
      let buffer = '';
      for await (const chunk of res.body) {
        buffer += Buffer.from(chunk).toString('utf8');
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          handleEvent(buffer.slice(0, end));
          buffer = buffer.slice(end + 2);
        }
      }
    } catch {
      // server restarting or unreachable; retry below
    }
    await sleep(3000);
    // If the server we attached to (e.g. `npm start`) went away, run our own.
    await ensureServer();
  }
}

function handleEvent(raw) {
  let event = 'message';
  let data = '';
  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data += line.slice(5).trim();
  }
  if (!data) return;
  const payload = JSON.parse(data);
  if (event === 'notify') showNotification(payload);
  else {
    lastView = payload;
    updateTray();
  }
}

// --- Windows ---

function showMainWindow(hash) {
  if (!mainWindow) {
    mainWindow = new BrowserWindow({
      width: 1440,
      height: 900,
      minWidth: 640,
      minHeight: 480,
      title: 'Critique',
      show: false,
      webPreferences: { preload: PRELOAD, sandbox: true, contextIsolation: true },
    });
    mainWindow.on('close', (e) => {
      // Closing hides the window; Critique keeps running in the menu bar.
      if (quitting) return;
      e.preventDefault();
      mainWindow.hide();
      app.dock?.hide();
    });
    routeLinks(mainWindow.webContents);
    mainWindow.loadURL(`${appUrl}${hash || ''}`);
    mainWindow.once('ready-to-show', () => mainWindow.show());
  } else {
    if (hash) mainWindow.webContents.executeJavaScript(`location.hash = ${JSON.stringify(hash.replace(/^#/, ''))}`);
    mainWindow.show();
  }
  app.dock?.show();
  mainWindow.focus();
}

const openReview = (query) => showMainWindow(`#review?${query}`);

// Critique's own pages open in app windows; everything else (GitHub, docs) in the default browser.
function routeLinks(contents) {
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(appUrl)) {
      const win = new BrowserWindow({ width: 1440, height: 900, webPreferences: { preload: PRELOAD, sandbox: true, contextIsolation: true } });
      routeLinks(win.webContents);
      win.loadURL(url);
    } else if (/^https?:\/\//.test(url)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  contents.on('will-navigate', (e, url) => {
    if (!url.startsWith(appUrl)) {
      e.preventDefault();
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
    }
  });
}

// --- Notifications ---

function showNotification({ title, body, url }) {
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title, body });
  notification.on('click', () => {
    const match = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url || '');
    if (match) openReview(new URLSearchParams({ repo: match[1], number: match[2] }).toString());
    else showMainWindow();
  });
  notification.show();
}

// --- Menu bar ---

function runAction(action) {
  switch (action.kind) {
    case 'review':
      post('/api/clicked', { url: action.url });
      openReview(action.query);
      break;
    case 'external':
      post('/api/clicked', { url: action.url });
      shell.openExternal(action.url);
      break;
    case 'copy':
      clipboard.writeText(action.text);
      break;
    case 'post':
      post(action.path, action.body);
      break;
  }
}

function prItem(entry) {
  return {
    label: entry.label,
    sublabel: entry.sublabel,
    icon: icon(`dot-${entry.dot}`),
    submenu: entry.actions.map((a) => (a.separator ? { type: 'separator' } : { label: a.label, click: () => runAction(a.action) })),
  };
}

function buildMenu(model) {
  const moreItem = (n) => ({ label: `${n} more in Critique…`, click: () => showMainWindow() });
  const template = [];

  if (model.error) {
    template.push({ label: model.error, sublabel: 'Open Critique for details', click: () => showMainWindow() }, { type: 'separator' });
  }

  template.push({ label: `Needs You (${model.needs.length + model.needsMore})`, type: 'header' });
  if (model.needs.length === 0) template.push({ label: "You're all caught up", enabled: false });
  template.push(...model.needs.map(prItem));
  if (model.needsMore) template.push(moreItem(model.needsMore));

  template.push(
    { type: 'separator' },
    {
      label: `Waiting on Others (${model.waiting.length + model.waitingMore})`,
      submenu: model.waiting.length
        ? [...model.waiting.map(prItem), ...(model.waitingMore ? [moreItem(model.waitingMore)] : [])]
        : [{ label: 'Nothing waiting on others', enabled: false }],
    },
    { type: 'separator' },
    { label: 'Open Critique', click: () => showMainWindow() },
    { label: model.polling ? 'Refreshing…' : 'Refresh', sublabel: model.updated || undefined, enabled: !model.polling, click: () => post('/api/refresh') },
    { label: 'Settings…', click: () => showMainWindow('#settings') },
    {
      label: 'Launch at Login',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
    },
    { type: 'separator' },
    { label: 'Quit Critique', click: () => app.quit() },
  );
  return Menu.buildFromTemplate(template);
}

function updateTray() {
  if (!tray || !lastView) return;
  const model = menuModel(lastView);
  tray.setTitle(model.title, { fontType: 'monospacedDigit' });
  tray.setToolTip(model.tooltip);
  trayMenu = buildMenu(model);
  tray.setContextMenu(trayMenu);
  notifySketchybar(model);
  if (pendingUrl) {
    handleUrl(pendingUrl);
    pendingUrl = null;
  }
  if (process.env.CRITIQUE_DEBUG) {
    console.log(`[tray] title=${JSON.stringify(model.title)} needs=${model.needs.length}+${model.needsMore} waiting=${model.waiting.length}`);
    for (const e of model.needs.slice(0, 3)) console.log(`[tray]   ${e.dot.padEnd(9)} ${e.label} — ${e.sublabel}`);
  }
}

// --- Other launchers ---

// critique://menu pops up the menu bar menu at the pointer. `?top=N` puts it N points below the top of
// the screen instead (e.g. under a SketchyBar bar), lined up with the pointer.
function handleUrl(raw) {
  if (process.env.CRITIQUE_DEBUG) console.log(`[url] ${raw}`);
  const url = new URL(raw);
  const action = url.hostname || url.pathname.replace(/^\/+/, '');
  if (action === 'menu') popUpMenu(Number(url.searchParams.get('top')) || null);
  else if (action === 'open') showMainWindow();
}

function popUpMenu(top) {
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const point = { x: cursor.x, y: top == null ? cursor.y : display.bounds.y + top };
  // A menu needs a window to pop up from: use an invisible one at the spot, without taking focus.
  const anchor = new BrowserWindow({
    ...point,
    width: 1,
    height: 1,
    show: false,
    frame: false,
    transparent: true,
    focusable: false,
    hasShadow: false,
    skipTaskbar: true,
  });
  anchor.showInactive();
  trayMenu.popup({ window: anchor, x: 0, y: 0, callback: () => anchor.destroy() });
}

const SKETCHYBAR = ['/opt/homebrew/bin/sketchybar', '/usr/local/bin/sketchybar'].find((p) => existsSync(p));
let lastSketchybarState = null;

// Tell SketchyBar's critique item the new count. Harmless when nothing subscribes to the event.
function notifySketchybar(model) {
  if (!SKETCHYBAR) return;
  const state = model.error ? 'error' : 'ok';
  const count = String(model.count);
  if (lastSketchybarState === `${state}:${count}`) return;
  lastSketchybarState = `${state}:${count}`;
  execFile(SKETCHYBAR, ['--trigger', 'critique_update', `COUNT=${count}`, `STATE=${state}`], () => {});
}

// Just the menus the window needs, so Critique takes less menu bar room while it's in front.
function setAppMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      {
        label: 'View',
        submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }],
      },
      { role: 'windowMenu' },
    ]),
  );
}

// --- Startup ---

app.whenReady().then(async () => {
  setAppMenu();
  tray = new Tray(icon('trayTemplate'));
  tray.setToolTip('Critique: starting…');
  trayMenu = Menu.buildFromTemplate([{ label: 'Starting…', enabled: false }, { label: 'Quit Critique', click: () => app.quit() }]);
  tray.setContextMenu(trayMenu);

  await ensureServer();
  watchServer();
  // Keep "Updated Xm ago" current even when nothing else changes.
  setInterval(updateTray, 60_000);

  // Launched at login or by a URL: stay in the menu bar. Opened by hand: show the dashboard too.
  if (launchedByUrl || app.getLoginItemSettings().wasOpenedAtLogin) app.dock?.hide();
  else showMainWindow();
});
