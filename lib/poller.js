// Fetches open PRs you're involved in, computes their attention sets, and
// decides what to notify about. No server or filesystem dependencies, so it
// can be tested with a fake fetcher.

import { computeAttentionSet, isActiveState, isBot } from './attention.js';
import { ghFetch } from './github.js';
import { fetchThreadSummaries } from './threads.js';

const CONCURRENCY = 10;
const MAX_TIMELINE_PAGES = 3; // 300 events
const MAX_HEAD_HISTORY = 30;

export function timelineUrl(repo, number, page) {
  return `https://api.github.com/repos/${repo}/issues/${number}/timeline?per_page=100&page=${page}`;
}

export async function fetchTimeline(repo, number, token, opts) {
  const timeline = [];
  for (let page = 1; page <= MAX_TIMELINE_PAGES; page++) {
    const path = timelineUrl(repo, number, page).replace('https://api.github.com', '');
    const batch = await ghFetch(path, token, opts);
    timeline.push(...batch);
    if (batch.length < 100) break;
  }
  return timeline;
}

/**
 * When the PR's head commit last changed. Plain pushes have no timestamp on GitHub, so this is the
 * first poll that saw the new SHA. For a PR we've never seen, estimate from the latest commit or
 * force-push in its history.
 */
export function headChangedAt(prev, headSha, timeline, now) {
  if (prev?.sha === headSha) return prev.since;
  if (prev) return now;
  let latest = 0;
  for (const ev of timeline) {
    const t = ev.event || ev.__type;
    const ts =
      t === 'committed'
        ? new Date(ev.committer?.date || 0).getTime()
        : t === 'head_ref_force_pushed'
          ? new Date(ev.created_at || 0).getTime()
          : 0;
    if (ts > latest) latest = ts;
  }
  return latest || now;
}

// Commits and files between your last-reviewed commit and the current head. Both SHAs are fixed, so
// results are cached forever (keyed by the range) instead of re-fetched each poll.
//
// The compare API needs the token's "Contents: read" permission. Without it, fall back to the PR's
// commit list (covered by "Pull requests: read"), which gives a commit count but no file count.
async function fetchSinceReview(repo, number, base, head, token, { fetcher, compareCache }) {
  const key = `${repo}@${base}...${head}`;
  if (!compareCache.has(key)) {
    try {
      compareCache.set(key, await compareRange(repo, base, head, token, fetcher));
    } catch (e) {
      if (e.status !== 403 && e.status !== 404) return null;
      try {
        compareCache.set(key, await countFromPrCommits(repo, number, base, token, fetcher));
      } catch {
        return null;
      }
    }
  }
  return { key, ...compareCache.get(key) };
}

async function compareRange(repo, base, head, token, fetcher) {
  const cmp = await ghFetch(`/repos/${repo}/compare/${base}...${head}`, token, { fetcher });
  return { newCommits: cmp.ahead_by ?? 0, filesChanged: (cmp.files || []).length, rebased: cmp.status === 'diverged' };
}

async function countFromPrCommits(repo, number, base, token, fetcher) {
  const commits = [];
  for (let page = 1; page <= 3; page++) {
    const batch = await ghFetch(`/repos/${repo}/pulls/${number}/commits?per_page=100&page=${page}`, token, { fetcher });
    commits.push(...batch);
    if (batch.length < 100) break;
  }
  const i = commits.findIndex((c) => c.sha === base);
  // The reviewed commit is gone from the branch: it was rebased or force-pushed.
  if (i === -1) return { newCommits: null, filesChanged: null, rebased: true };
  return { newCommits: commits.length - i - 1, filesChanged: null, rebased: false };
}

/**
 * @param {string} token
 * @param {{ debounceMinutes: number, onlyDirectRequests?: boolean, whitelistedTeams?: string[], pushReturnsTurn?: boolean }} settings
 * @param {{ headSeen?: Record<string, {sha: string, since: number}>, compareCache?: Map }} opts
 *   headSeen: head SHAs from the previous poll, so we know when a push happened.
 * @returns {Promise<{ username: string, results: object[], headSeen: object, usedUrls: Set<string>, usedCompareKeys: Set<string> }>}
 */
export async function fetchAttention(
  token,
  settings,
  { fetcher = fetch, etagCache = null, now = Date.now(), headSeen = {}, compareCache = new Map() } = {},
) {
  const usedUrls = new Set();
  const usedCompareKeys = new Set();
  const nextHeadSeen = {};
  const opts = { fetcher, etagCache, used: usedUrls };

  const user = await ghFetch('/user', token, { fetcher });
  const username = user.login;

  const search = await ghFetch(`/search/issues?q=involves:${username}+is:pr+is:open&per_page=50`, token, { fetcher });
  const items = search.items || [];
  const results = [];

  for (let i = 0; i < items.length; i += CONCURRENCY) {
    const batch = items.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (pr) => {
        const repo = pr.repository_url.replace('https://api.github.com/repos/', '');

        const [timeline, headSha] = await Promise.all([
          fetchTimeline(repo, pr.number, token, opts).catch(() => []),
          ghFetch(`/repos/${repo}/pulls/${pr.number}`, token, opts)
            .then((p) => p.head?.sha || null)
            .catch(() => null),
        ]);

        let changedAt = 0;
        if (headSha) {
          changedAt = headChangedAt(headSeen[pr.html_url], headSha, timeline, now);
          // Keep every head we've seen so the review page can offer versions lost to force-pushes.
          const prev = headSeen[pr.html_url];
          const history = prev?.history || (prev ? [{ sha: prev.sha, since: prev.since }] : []);
          if (history.at(-1)?.sha !== headSha) history.push({ sha: headSha, since: changedAt });
          nextHeadSeen[pr.html_url] = { sha: headSha, since: changedAt, history: history.slice(-MAX_HEAD_HISTORY) };
        }

        const attention = computeAttentionSet(timeline, username, pr.user.login, settings.debounceMinutes, now, {
          onlyDirectRequests: settings.onlyDirectRequests,
          whitelistedTeams: settings.whitelistedTeams,
          headSha,
          headChangedAt: changedAt,
          pushReturnsTurn: settings.pushReturnsTurn,
        });

        let sinceReview = null;
        if (attention.pushedSinceMyReview) {
          const base = attention.myLastReviewCommit;
          const cmp = await fetchSinceReview(repo, pr.number, base, headSha, token, { fetcher, compareCache });
          if (cmp) usedCompareKeys.add(cmp.key);
          sinceReview = {
            newCommits: cmp?.newCommits ?? null,
            filesChanged: cmp?.filesChanged ?? null,
            rebased: cmp?.rebased ?? false,
            base,
            url: `${pr.html_url}/files/${base}..${headSha}`,
          };
        }

        let lastEventAt = 0;
        for (const event of timeline) {
          const ts = new Date(event.created_at || event.submitted_at || 0).getTime();
          if (ts > lastEventAt) lastEventAt = ts;
        }
        if (changedAt > lastEventAt) lastEventAt = changedAt; // count pushes as activity

        return {
          id: pr.id,
          number: pr.number,
          title: pr.title,
          url: pr.html_url,
          repo,
          author: pr.user.login,
          attentionSet: attention.set,
          reviewerStates: attention.reviewerStates,
          allReviewers: attention.allReviewers,
          myStatus: attention.myStatus,
          prState: attention.prState,
          myReason: attention.myReason,
          myRole: attention.myRole,
          incomingDetail: attention.incomingDetail,
          selfRequested: attention.selfRequested,
          sinceReview,
          headSha,
          lastEventAt,
          othersActivityAt: othersActivityAt(timeline, username),
        };
      }),
    );
    results.push(...batchResults);
  }

  // Thread counts are a nice-to-have; a GraphQL hiccup shouldn't fail the whole poll.
  try {
    const summaries = await fetchThreadSummaries(results, username, token, { fetcher });
    for (const pr of results) pr.threads = summaries[pr.url] || null;
  } catch {
    for (const pr of results) pr.threads = null;
  }

  return { username, results, headSeen: nextHeadSeen, usedUrls, usedCompareKeys };
}

/** Applies the include/exclude repo list from settings and the muted repos/owners from state. */
export function applyFilters(results, settings, state) {
  const lower = (list) => new Set((list || []).map((s) => s.trim().toLowerCase()).filter(Boolean));
  const repoList = lower(settings.repoFilterList);
  const mutedRepos = lower(state.mutedRepos);
  const mutedOwners = lower(state.mutedOwners);

  return results.filter((pr) => {
    const repo = pr.repo.toLowerCase();
    const owner = repo.split('/')[0];
    if (repoList.size > 0) {
      if (settings.repoFilterMode === 'include' && !repoList.has(repo)) return false;
      if (settings.repoFilterMode === 'exclude' && repoList.has(repo)) return false;
    }
    return !mutedRepos.has(repo) && !mutedOwners.has(owner);
  });
}

// Events that count as someone responding, for "Not my turn" (see applyAttentionOverrides).
const RESPONSE_EVENTS = new Set(['reviewed', 'commented', 'line-commented', 'head_ref_force_pushed']);

/** When someone other than you (and not a bot) last reviewed, commented, or force-pushed. */
export function othersActivityAt(timeline, me) {
  let latest = 0;
  for (const ev of timeline) {
    if (!RESPONSE_EVENTS.has(ev.event || ev.__type)) continue;
    const who = ev.actor || ev.user;
    if (!who?.login || who.login === me || isBot(who.login, who)) continue;
    const ts = new Date(ev.submitted_at || ev.created_at || 0).getTime();
    if (ts > latest) latest = ts;
  }
  return latest;
}

/**
 * Apply "Not my turn": for each PR you stepped out of, take you out of its attention set until someone
 * else responds after that. Returns the adjusted results and the overrides that have expired.
 * @param {Record<string, { at: number }>} overrides  PR url -> when you stepped out
 */
export function applyAttentionOverrides(results, overrides, me) {
  const expired = [];
  const adjusted = results.map((pr) => {
    const override = overrides?.[pr.url];
    if (!override) return pr;
    if ((pr.othersActivityAt || 0) > override.at) {
      expired.push(pr.url);
      return pr;
    }
    const attentionSet = { ...pr.attentionSet };
    delete attentionSet[me];
    // Never leave an active PR with nobody's turn: hand it to the author. If that's you, there's
    // nobody to hand it to, so the step-out lapses.
    if (Object.keys(attentionSet).length === 0 && isActiveState(pr.prState)) {
      if (pr.author === me) {
        expired.push(pr.url);
        return pr;
      }
      attentionSet[pr.author] = 'red';
    }
    return { ...pr, myStatus: 'green', attentionSet, steppedOutAt: override.at };
  });
  return { results: adjusted, expired };
}

export function needsAttentionCount(visible, dismissed) {
  return visible.filter((pr) => pr.myStatus === 'red' && !dismissed[pr.url]).length;
}

/**
 * Notify only when a PR newly turns red for you. Never notifies on the very
 * first poll (so startup doesn't fire for every existing red PR), and skips
 * PRs where you requested the review yourself.
 * @returns {{ notify: object[], lastNotifiedPRs: Record<string, string> }}
 */
export function selectNotifications(visible, dismissed, lastNotifiedPRs) {
  const isFirstPoll = Object.keys(lastNotifiedPRs).length === 0;
  const notify = isFirstPoll
    ? []
    : visible.filter(
        (pr) => pr.myStatus === 'red' && !dismissed[pr.url] && lastNotifiedPRs[pr.url] !== 'red' && !pr.selfRequested,
      );

  const next = {};
  for (const pr of visible) {
    if (!dismissed[pr.url]) next[pr.url] = pr.myStatus;
  }
  return { notify, lastNotifiedPRs: next };
}
