import { describe, it, expect } from 'vitest';
import { computeAttentionSet } from '../lib/attention.js';
import { fetchAttention, headChangedAt } from '../lib/poller.js';

const NOW = new Date('2026-10-20T12:00:00Z').getTime();
const HOUR = 60 * 60 * 1000;
const user = (login) => ({ login, type: 'User' });

// alice authors, me reviews on commit sha1 and requests changes.
const reviewedTimeline = (state = 'changes_requested') => [
  { event: 'review_requested', actor: user('alice'), requested_reviewer: user('me'), created_at: '2026-10-19T00:00:00Z' },
  { event: 'reviewed', user: user('me'), state, commit_id: 'sha1', submitted_at: '2026-10-19T01:00:00Z' },
];

const compute = (timeline, me, opts) => computeAttentionSet(timeline, me, 'alice', 10, NOW, opts);

describe('pushes after review', () => {
  it('marks my review as stale when the head moved', () => {
    const r = compute(reviewedTimeline(), 'me', { headSha: 'sha2', headChangedAt: NOW - HOUR });
    expect(r.incomingDetail).toBe('updated');
    expect(r.pushedSinceMyReview).toBe(true);
    expect(r.myLastReviewCommit).toBe('sha1');
  });

  it('is not updated when the head is the commit I reviewed', () => {
    const r = compute(reviewedTimeline(), 'me', { headSha: 'sha1', headChangedAt: NOW - HOUR, pushReturnsTurn: true });
    expect(r.incomingDetail).toBe(null);
    expect(r.set).toEqual({ alice: 'red' });
  });

  it('keeps the turn with the author when pushReturnsTurn is off', () => {
    const r = compute(reviewedTimeline(), 'me', { headSha: 'sha2', headChangedAt: NOW - HOUR });
    expect(r.set).toEqual({ alice: 'red' });
    expect(r.myStatus).toBe('green');
  });

  it('hands the turn back to the reviewer after a settled push', () => {
    const r = compute(reviewedTimeline(), 'me', { headSha: 'sha2', headChangedAt: NOW - HOUR, pushReturnsTurn: true });
    expect(r.set).toEqual({ me: 'red' });
    expect(r.myStatus).toBe('red');
    expect(r.prState).toBe('REVIEWING');
  });

  it('shows the author as waiting once they push', () => {
    const r = compute(reviewedTimeline('commented'), 'alice', {
      headSha: 'sha2',
      headChangedAt: NOW - HOUR,
      pushReturnsTurn: true,
    });
    expect(r.myStatus).toBe('green');
    expect(r.set).toEqual({ me: 'red' });
  });

  it('waits out the debounce before moving the turn', () => {
    const r = compute(reviewedTimeline(), 'me', {
      headSha: 'sha2',
      headChangedAt: NOW - 5 * 60 * 1000,
      pushReturnsTurn: true,
    });
    expect(r.set).toEqual({ alice: 'red' });
    expect(r.incomingDetail).toBe('updated');
  });

  it('leaves approvals alone', () => {
    const r = compute(reviewedTimeline('approved'), 'me', { headSha: 'sha2', headChangedAt: NOW - HOUR, pushReturnsTurn: true });
    expect(r.set).toEqual({ alice: 'red' }); // author's turn to merge
    expect(r.incomingDetail).toBe('updated');
  });
});

describe('headChangedAt', () => {
  const timeline = [
    { event: 'committed', committer: { date: '2026-10-18T00:00:00Z' } },
    { event: 'head_ref_force_pushed', created_at: '2026-10-19T00:00:00Z' },
  ];

  it('keeps the previous time when the head has not moved', () => {
    expect(headChangedAt({ sha: 'a', since: 5 }, 'a', timeline, NOW)).toBe(5);
  });

  it('uses now when the head moved since the last poll', () => {
    expect(headChangedAt({ sha: 'a', since: 5 }, 'b', timeline, NOW)).toBe(NOW);
  });

  it('estimates from history for a PR it has never seen', () => {
    expect(headChangedAt(undefined, 'b', timeline, NOW)).toBe(new Date('2026-10-19T00:00:00Z').getTime());
  });
});

describe('fetchAttention since-review stats', () => {
  const responses = {
    '/user': { login: 'me' },
    '/search/issues': {
      items: [
        {
          id: 1,
          number: 7,
          title: 'Add thing',
          html_url: 'https://github.com/acme/app/pull/7',
          repository_url: 'https://api.github.com/repos/acme/app',
          user: { login: 'alice' },
        },
      ],
    },
    '/repos/acme/app/issues/7/timeline': reviewedTimeline(),
    '/repos/acme/app/pulls/7': { head: { sha: 'sha2' } },
    '/repos/acme/app/compare/sha1...sha2': { ahead_by: 3, status: 'ahead', files: [{}, {}] },
  };

  const makeFetcher = (calls) => async (url) => {
    const path = new URL(url).pathname;
    calls.push(path);
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => responses[path] };
  };

  it('reports commits and files since my review with a diff link', async () => {
    const calls = [];
    const compareCache = new Map();
    const { results, headSeen } = await fetchAttention('t', { debounceMinutes: 10, pushReturnsTurn: true }, {
      fetcher: makeFetcher(calls),
      now: NOW,
      compareCache,
    });
    expect(results[0].sinceReview).toEqual({
      newCommits: 3,
      filesChanged: 2,
      rebased: false,
      base: 'sha1',
      url: 'https://github.com/acme/app/pull/7/files/sha1..sha2',
    });
    // No commits in the history to date the push, so it counts as just seen and waits out the debounce.
    expect(results[0].myStatus).toBe('green');
    expect(headSeen['https://github.com/acme/app/pull/7']).toEqual({ sha: 'sha2', since: NOW, history: [{ sha: 'sha2', since: NOW }] });

    // A poll after the debounce hands me the turn, reusing the cached comparison.
    const calls2 = [];
    const later = await fetchAttention('t', { debounceMinutes: 10, pushReturnsTurn: true }, {
      fetcher: makeFetcher(calls2),
      now: NOW + 11 * 60 * 1000,
      compareCache,
      headSeen,
    });
    expect(later.results[0].myStatus).toBe('red');
    expect(calls2.some((p) => p.includes('/compare/'))).toBe(false);
  });

  it('falls back to the PR commit list when the token lacks Contents access', async () => {
    const fetcher = async (url) => {
      const path = new URL(url).pathname;
      if (path.includes('/compare/')) return { ok: false, status: 403, headers: { get: () => null } };
      if (path === '/repos/acme/app/pulls/7/commits') {
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => [{ sha: 'sha0' }, { sha: 'sha1' }, { sha: 'sha1b' }, { sha: 'sha2' }] };
      }
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => responses[path] };
    };
    const { results } = await fetchAttention('t', { debounceMinutes: 10 }, { fetcher, now: NOW });
    expect(results[0].sinceReview).toMatchObject({ newCommits: 2, filesChanged: null, rebased: false });
  });
});
