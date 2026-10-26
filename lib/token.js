// GitHub PAT stored in the macOS login Keychain. Set it with `npm run set-token`.

import { execFile } from 'node:child_process';
import { userInfo } from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const KEYCHAIN_SERVICE = 'critique-github-pat';
export const KEYCHAIN_ACCOUNT = userInfo().username;
const ITEM_NOT_FOUND = 44;

export async function readToken() {
  if (process.env.CRITIQUE_DEMO) return 'demo'; // demo/server.js answers GitHub requests itself
  try {
    const { stdout } = await execFileAsync('security', [
      'find-generic-password',
      '-s',
      KEYCHAIN_SERVICE,
      '-a',
      KEYCHAIN_ACCOUNT,
      '-w',
    ]);
    return stdout.trim();
  } catch (e) {
    const message =
      e.code === ITEM_NOT_FOUND
        ? 'No GitHub token in Keychain. Run `npm run set-token`.'
        : `Could not read GitHub token from Keychain: ${e.message}`;
    throw Object.assign(new Error(message), { status: 401 });
  }
}
