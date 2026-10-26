#!/usr/bin/env node
// Saves a GitHub PAT to the macOS Keychain, then checks it against the API.
// `security` prompts for the token itself, so it never appears in argv or shell history.

import { spawnSync } from 'node:child_process';

import { ghFetch } from '../lib/github.js';
import { KEYCHAIN_ACCOUNT, KEYCHAIN_SERVICE, readToken } from '../lib/token.js';

console.log('Paste a fine-grained PAT with read-only access to "Pull requests" and "Issues".');
console.log('Create one at https://github.com/settings/personal-access-tokens/new\n');

const { status } = spawnSync(
  'security',
  ['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-l', 'critique GitHub PAT', '-w'],
  { stdio: 'inherit' },
);
if (status !== 0) {
  console.error('\nKeychain did not save the token.');
  process.exit(1);
}

try {
  const user = await ghFetch('/user', await readToken());
  console.log(`\nSaved. The token works for @${user.login}.`);
} catch (e) {
  console.error(`\nSaved, but GitHub rejected it: ${e.message}`);
  process.exit(1);
}
