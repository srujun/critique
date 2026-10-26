// Captures the README screenshots from the demo data, in light and dark: `npm run screenshots`.
// Pages render offscreen at 2x, so nothing appears on screen.

import { app, BrowserWindow, nativeTheme } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { sha } from './fixtures.js';

const OUT = join(import.meta.dirname, '..', 'docs', 'screenshots');
const SCALE = 2;
const port = (process.env.PORT ||= '7879');
const base = `http://localhost:${port}`;
const review = new URLSearchParams({ repo: 'acme/web', number: 1290, base: sha('web-1290-c2') });

const SHOTS = [
  {
    name: 'review',
    url: `${base}/#review?${review}`,
    width: 1600,
    height: 1000,
    settle: 4000,
    // Jump to the thread waiting on you (its badge is the last one in the file list).
    prepare: `document.querySelector('iframe').contentDocument.querySelectorAll('button.tag.waiting').forEach((b, i, all) => i === all.length - 1 && b.click())`,
  },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function capture({ name, url, width, height, settle = 1500, prepare }, theme) {
  nativeTheme.themeSource = theme;
  const win = new BrowserWindow({
    show: false,
    width: width * SCALE,
    height: height * SCALE,
    webPreferences: { offscreen: true, zoomFactor: SCALE },
  });
  await win.loadURL(url);
  for (let i = 0; i < 50; i++) {
    if (await win.webContents.executeJavaScript(`document.body.innerText.includes('Migrate the settings page')`)) break;
    await sleep(100);
  }
  await sleep(settle);
  if (prepare) {
    await win.webContents.executeJavaScript(prepare);
    await sleep(1000);
  }
  const image = await win.webContents.capturePage();
  writeFileSync(join(OUT, `${name}-${theme}.png`), image.toPNG());
  win.destroy();
}

app.on('window-all-closed', () => {}); // keep going between shots; quit when done

app.whenReady().then(async () => {
  await import('./server.js');
  mkdirSync(OUT, { recursive: true });
  for (const shot of SHOTS) for (const theme of ['light', 'dark']) await capture(shot, theme);
  app.quit();
}).catch((e) => {
  console.error(e);
  app.exit(1);
});
