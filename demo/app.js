// The desktop app on demo data (`npm run demo:app`), for trying it out or screenshotting the menu.
// Uses its own app data folder so it can run next to your real Critique.

import { app } from 'electron';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

app.setName('Critique Demo');
app.setPath('userData', mkdtempSync(join(tmpdir(), 'critique-demo-app-')));

await import('./server.js');
await import('../desktop/main.js');
