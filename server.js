#!/usr/bin/env node
// Local attention-set dashboard: polls GitHub, serves the dashboard and review pages on localhost,
// pushes updates and notifications to open tabs over SSE, and proxies GitHub for the review page
// so the token never reaches the browser.

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { extname, join } from 'node:path';

import { fetchConversation } from './lib/conversation.js';
import { GitHubError, ghFetch } from './lib/github.js';
import {
  applyAttentionOverrides,
  applyFilters,
  fetchAttention,
  fetchTimeline,
  needsAttentionCount,
  selectNotifications,
} from './lib/poller.js';
import { buildDiff, buildRevisions, fileContents, myLastReviewCommit } from './lib/review.js';
import { DEFAULT_STATE, HOME, loadSettings, normalizeSettings, readJson, writeJson } from './lib/store.js';
import { fetchThreads } from './lib/threads.js';
import { readToken } from './lib/token.js';

const PUBLIC_DIR = join(import.meta.dirname, 'public');
const BUILD_DIR = join(PUBLIC_DIR, 'build'); // bundled review page, from `npm run build`
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/theme.js': ['theme.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/review': ['review.html', 'text/html; charset=utf-8'],
  '/review.css': ['review.css', 'text/css; charset=utf-8'],
};
const BUILD_TYPES = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.map': 'application/json' };

const settings = loadSettings();
const port = Number(process.env.PORT) || settings.port;
const dashboardUrl = `http://localhost:${port}/`;
const state = readJson('state.json', DEFAULT_STATE);
const etagCache = new Map(Object.entries(readJson('etag-cache.json', {})));

let snapshot = { username: null, results: [], lastPoll: null, lastError: null };
let inFlight = null;
let pollTimer = null;
const sseClients = new Set();

// --- Token ---

// The review page makes many small requests (one per file it expands), so don't hit Keychain for each.
let tokenCache = { value: null, at: 0 };
async function getToken() {
  if (!tokenCache.value || Date.now() - tokenCache.at > 60_000) tokenCache = { value: await readToken(), at: Date.now() };
  return tokenCache.value;
}

// --- Polling ---

function saveState() {
  writeJson('state.json', state);
}

function schedulePolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(pollOnce, settings.pollMinutes * 60_000);
}

function pollOnce() {
  inFlight ??= doPoll().finally(() => {
    inFlight = null;
    broadcast();
  });
  broadcast();
  return inFlight;
}

async function doPoll() {
  try {
    // Re-read from Keychain every poll so a rotated token takes effect without a restart.
    tokenCache = { value: await readToken(), at: Date.now() };
    const token = tokenCache.value;
    const compareCache = new Map(Object.entries(state.sinceReviewCache));
    const { username, results, headSeen, usedUrls, usedCompareKeys } = await fetchAttention(token, settings, {
      etagCache,
      headSeen: state.headSeen,
      compareCache,
    });
    snapshot = { username, results, lastPoll: Date.now(), lastError: null };
    state.headSeen = headSeen;

    // Keep only cache entries this poll still used, so closed PRs drop out.
    for (const url of etagCache.keys()) if (!usedUrls.has(url)) etagCache.delete(url);
    state.sinceReviewCache = Object.fromEntries([...compareCache].filter(([key]) => usedCompareKeys.has(key)));
    writeJson('etag-cache.json', Object.fromEntries(etagCache));

    // "Not my turn" overrides end once someone else responds; you get notified when that hands it back.
    const { results: adjusted, expired } = applyAttentionOverrides(results, state.attentionOverrides, username);
    for (const url of expired) delete state.attentionOverrides[url];
    const visible = applyFilters(adjusted, settings, state);
    if (settings.notifications !== false) {
      const { notify: toNotify, lastNotifiedPRs } = selectNotifications(visible, state.dismissed, state.lastNotifiedPRs);
      state.lastNotifiedPRs = lastNotifiedPRs;
      if (toNotify.length === 1) {
        const pr = toNotify[0];
        sendNotification({ title: 'Critique', body: `${pr.title} needs your attention`, url: pr.url, tag: pr.url });
      } else if (toNotify.length > 1) {
        sendNotification({
          title: 'Critique',
          body: `${toNotify.length} new PRs need your attention`,
          url: dashboardUrl,
          tag: 'critique-batch',
        });
      }
    }

    // Forget dismiss/click state for PRs that are no longer open.
    const open = new Set(results.map((r) => r.url));
    for (const key of ['dismissed', 'dismissedClicked', 'viewedFiles', 'attentionOverrides']) {
      state[key] = Object.fromEntries(Object.entries(state[key]).filter(([url]) => open.has(url)));
    }
    saveState();
  } catch (e) {
    console.error('Poll failed:', e.message);
    let type = 'network';
    if (e.status === 401 || e.status === 403) {
      type = 'auth';
    } else if (e.status >= 500) {
      type = 'server';
    }
    snapshot = { ...snapshot, lastError: { type, message: e.message, at: Date.now() } };
  }
}

// --- View + SSE ---

function view() {
  const { results: adjusted } = applyAttentionOverrides(snapshot.results, state.attentionOverrides, snapshot.username);
  const results = applyFilters(adjusted, settings, state);
  return {
    username: snapshot.username,
    lastPoll: snapshot.lastPoll,
    lastError: snapshot.lastError,
    polling: !!inFlight,
    settings: {
      pollMinutes: settings.pollMinutes,
      debounceMinutes: settings.debounceMinutes,
      notifications: settings.notifications,
      pushReturnsTurn: settings.pushReturnsTurn,
      onlyDirectRequests: settings.onlyDirectRequests,
      whitelistedTeams: settings.whitelistedTeams,
      repoFilterMode: settings.repoFilterMode,
      repoFilterList: settings.repoFilterList,
    },
    results,
    needsAttention: needsAttentionCount(results, state.dismissed),
    dismissed: state.dismissed,
    dismissedClicked: state.dismissedClicked,
    mutedRepos: state.mutedRepos,
    mutedOwners: state.mutedOwners,
  };
}

function broadcast() {
  const payload = `data: ${JSON.stringify(view())}\n\n`;
  for (const res of sseClients) res.write(payload);
}

// Notifications are shown by open dashboard tabs (browser notifications), so none appear without one.
// The tag lets the browser collapse duplicates when several tabs are open.
function sendNotification({ title, body, url, tag }) {
  const payload = `event: notify\ndata: ${JSON.stringify({ title, body, url, tag })}\n\n`;
  for (const res of sseClients) res.write(payload);
}

// --- Actions from the UI ---

const addTo = (list, value) => value && !list.includes(value) && list.push(value);
const removeFrom = (list, value) => list.filter((v) => v !== value);

const actions = {
  '/api/refresh': () => pollOnce(),
  '/api/dismiss': ({ url, lastEventAt }) => {
    state.dismissed[url] = { dismissedAt: Date.now(), lastEventAt: lastEventAt || 0 };
  },
  '/api/restore': ({ url }) => {
    delete state.dismissed[url];
  },
  '/api/clicked': ({ url }) => {
    state.dismissedClicked[url] = Date.now();
  },
  '/api/mute': ({ repo, owner }) => {
    addTo(state.mutedRepos, repo);
    addTo(state.mutedOwners, owner);
  },
  '/api/unmute': ({ repo, owner }) => {
    if (repo) state.mutedRepos = removeFrom(state.mutedRepos, repo);
    if (owner) state.mutedOwners = removeFrom(state.mutedOwners, owner);
  },
  '/api/settings': (body) => {
    const previousPollMinutes = settings.pollMinutes;
    Object.assign(settings, normalizeSettings(body, settings));
    writeJson('config.json', settings);
    if (settings.pollMinutes !== previousPollMinutes) schedulePolling();
    // Debounce and team settings change the computed attention sets, so re-fetch rather than wait.
    pollOnce();
  },
  // "Not my turn" (mine: false) until someone else responds, or back to normal (mine: true).
  '/api/attention': ({ url, mine }) => {
    if (mine) delete state.attentionOverrides[url];
    else state.attentionOverrides[url] = { at: Date.now() };
  },
  '/api/review/viewed': ({ url, path, blobSha }) => {
    state.viewedFiles[url] ??= {};
    if (blobSha) state.viewedFiles[url][path] = blobSha;
    else delete state.viewedFiles[url][path];
  },
  '/api/test-notification': () => {
    sendNotification({ title: 'Critique', body: 'Notifications are working.', url: dashboardUrl, tag: 'critique-test' });
  },
};

// --- Review page (GitHub proxy) ---

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const SHA_RE = /^[0-9a-f]{40}$/;

class BadRequest extends Error {}

function prParams(url) {
  const repo = url.searchParams.get('repo') || '';
  const number = Number(url.searchParams.get('number'));
  if (!REPO_RE.test(repo) || !Number.isInteger(number) || number <= 0) throw new BadRequest('expected repo=owner/name&number=N');
  return { repo, number, prUrl: `https://github.com/${repo}/pull/${number}` };
}

function shaParam(url, name) {
  const value = url.searchParams.get(name);
  if (!value) return null;
  if (!SHA_RE.test(value)) throw new BadRequest(`${name} must be a full commit SHA`);
  return value;
}

const fetchPr = (repo, number, token) => ghFetch(`/repos/${repo}/pulls/${number}`, token, { etagCache });

const reviewRoutes = {
  // PR summary, versions to compare, your reviewed files, and comment threads.
  '/api/review': async (url, token) => {
    const { repo, number, prUrl } = prParams(url);
    const pr = await fetchPr(repo, number, token);
    const me = snapshot.username || (await ghFetch('/user', token)).login;
    const [timeline, threads] = await Promise.all([
      fetchTimeline(repo, number, token, { etagCache }),
      fetchThreads(repo, number, me, pr.user.login, token),
    ]);
    return {
      pr: {
        repo,
        number,
        url: pr.html_url,
        title: pr.title,
        author: pr.user.login,
        state: pr.merged_at ? 'merged' : pr.state,
        draft: pr.draft,
        headSha: pr.head.sha,
        baseRef: pr.base.ref,
      },
      me,
      revisions: buildRevisions(timeline, state.headSeen[prUrl]?.history, pr.head.sha, me),
      myLastReviewCommit: myLastReviewCommit(timeline, me),
      viewed: state.viewedFiles[prUrl] || {},
      threads,
    };
  },
  // Description and timeline for the Conversation view.
  '/api/review/conversation': async (url, token) => {
    const { repo, number } = prParams(url);
    return fetchConversation(repo, number, token);
  },
  '/api/review/diff': async (url, token) => {
    const { repo, number } = prParams(url);
    const pr = await fetchPr(repo, number, token);
    return buildDiff(repo, pr, shaParam(url, 'base'), shaParam(url, 'head'), token);
  },
};

async function serveFileContents(url, res) {
  const repo = url.searchParams.get('repo') || '';
  const ref = shaParam(url, 'ref');
  const path = url.searchParams.get('path') || '';
  if (!REPO_RE.test(repo) || !ref || !path || path.startsWith('/')) throw new BadRequest('expected repo, ref and path');
  const text = await fileContents(repo, ref, path, await getToken());
  if (text === null) return send(res, 404, { error: 'not found' });
  // Contents at a SHA never change, so let the browser cache them.
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'private, max-age=31536000, immutable' });
  res.end(text);
}

async function serveBuild(pathname, res) {
  const name = pathname.slice('/build/'.length);
  if (!/^[\w.-]+$/.test(name) || !BUILD_TYPES[extname(name)]) return send(res, 404, { error: 'not found' });
  try {
    const body = await readFile(join(BUILD_DIR, name));
    res.writeHead(200, { 'Content-Type': BUILD_TYPES[extname(name)], 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch {
    send(res, 404, { error: 'not built; run `npm run build`' });
  }
}

// --- HTTP ---

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

const server = http.createServer(async (req, res) => {
  // Only answer requests addressed to this machine (blocks DNS rebinding).
  if (![`localhost:${port}`, `127.0.0.1:${port}`].includes(req.headers.host)) return send(res, 403, { error: 'bad host' });
  const url = new URL(req.url, dashboardUrl);
  const { pathname } = url;

  try {
    if (req.method === 'GET' && STATIC[pathname]) {
      const [file, type] = STATIC[pathname];
      return send(res, 200, await readFile(join(PUBLIC_DIR, file), 'utf8'), type);
    }
    if (req.method === 'GET' && pathname.startsWith('/build/')) return serveBuild(pathname, res);
    if (req.method === 'GET' && pathname === '/api/review/file') return serveFileContents(url, res);
    if (req.method === 'GET' && reviewRoutes[pathname]) return send(res, 200, await reviewRoutes[pathname](url, await getToken()));
    if (req.method === 'GET' && pathname === '/api/data') return send(res, 200, view());
    if (req.method === 'GET' && pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify(view())}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }
    if (req.method === 'POST' && actions[pathname]) {
      // Requiring JSON forces a CORS preflight, which we never approve, so other sites can't post here.
      if (!req.headers['content-type']?.startsWith('application/json')) return send(res, 415, { error: 'expected JSON' });
      await actions[pathname](await readBody(req));
      saveState();
      broadcast();
      return send(res, 200, view());
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    if (e instanceof BadRequest) return send(res, 400, { error: e.message });
    if (e instanceof GitHubError) return send(res, e.status === 404 ? 404 : 502, { error: e.message, status: e.status });
    console.error(e);
    send(res, 500, { error: e.message });
  }
});

// Keep SSE connections from idling out.
setInterval(() => {
  for (const res of sseClients) res.write(': ping\n\n');
}, 30_000);

server.listen(port, '127.0.0.1', () => {
  console.log(`Critique running at ${dashboardUrl}`);
  console.log(`Config and state in ${HOME}`);
  if (process.argv.includes('--open')) execFile('open', [dashboardUrl]);
  pollOnce();
  schedulePolling();
});
