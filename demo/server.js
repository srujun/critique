#!/usr/bin/env node
// Runs Critique against made-up PRs (demo/fixtures.js) instead of GitHub, for screenshots and trying
// the UI without a token. State goes to a temporary folder, and it serves on port 7879 by default so
// it can run next to your real Critique.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFakeGitHub } from './fake-github.js';

process.env.CRITIQUE_DEMO = '1';
process.env.CRITIQUE_HOME ||= mkdtempSync(join(tmpdir(), 'critique-demo-'));
process.env.PORT ||= '7879';
globalThis.fetch = createFakeGitHub(globalThis.fetch);

await import('../server.js');
