// JSON files under ~/.config/critique (override with CRITIQUE_HOME).
//   config.json      settings you edit by hand
//   state.json       dismissed/muted/notified state the app manages
//   etag-cache.json  cached GitHub timeline responses

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const HOME = process.env.CRITIQUE_HOME || join(homedir(), '.config', 'critique');

export const DEFAULT_SETTINGS = {
  port: 7878,
  pollMinutes: 2,
  debounceMinutes: 10,
  notifications: true,
  pushReturnsTurn: true, // a push after review hands the turn back to reviewers
  onlyDirectRequests: false,
  whitelistedTeams: [],
  repoFilterMode: 'all', // 'all' | 'include' | 'exclude'
  repoFilterList: [], // ["owner/repo", ...]
};

export const DEFAULT_STATE = {
  dismissed: {}, // url -> { dismissedAt, lastEventAt }
  dismissedClicked: {}, // url -> last time you opened it from the dashboard
  mutedRepos: [],
  mutedOwners: [],
  lastNotifiedPRs: {}, // url -> myStatus at last poll
  headSeen: {}, // url -> { sha, since }: each PR's head commit and when we first saw it
  sinceReviewCache: {}, // 'repo@base...head' -> { newCommits, filesChanged, rebased }
  viewedFiles: {}, // PR url -> { path: blob SHA you marked reviewed }
  attentionOverrides: {}, // PR url -> { at }: you stepped out ("Not my turn") until someone responds
};

export function readJson(name, defaults) {
  try {
    return { ...defaults, ...JSON.parse(readFileSync(join(HOME, name), 'utf8')) };
  } catch {
    return structuredClone(defaults);
  }
}

export function writeJson(name, data) {
  mkdirSync(HOME, { recursive: true });
  const path = join(HOME, name);
  writeFileSync(`${path}.tmp`, JSON.stringify(data, null, 2) + '\n');
  renameSync(`${path}.tmp`, path);
}

/** Coerces settings posted from the UI into the stored shape, clamping numbers and dropping unknown keys. */
export function normalizeSettings(input, current) {
  const int = (v, min, max, fallback) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  const list = (v) =>
    (Array.isArray(v) ? v : String(v || '').split(/[\n,]/)).map((s) => String(s).trim()).filter(Boolean);

  return {
    ...current,
    pollMinutes: int(input.pollMinutes, 1, 60, current.pollMinutes),
    debounceMinutes: int(input.debounceMinutes, 0, 120, current.debounceMinutes),
    notifications: input.notifications === true,
    pushReturnsTurn: input.pushReturnsTurn === true,
    onlyDirectRequests: input.onlyDirectRequests === true,
    whitelistedTeams: list(input.whitelistedTeams),
    repoFilterMode: ['all', 'include', 'exclude'].includes(input.repoFilterMode) ? input.repoFilterMode : 'all',
    repoFilterList: list(input.repoFilterList),
  };
}

/** Loads settings, writing a default config.json on first run so it's easy to find and edit. */
export function loadSettings() {
  if (!existsSync(join(HOME, 'config.json'))) writeJson('config.json', DEFAULT_SETTINGS);
  return readJson('config.json', DEFAULT_SETTINGS);
}
