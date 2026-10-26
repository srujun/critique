import { describe, it, expect } from 'vitest';
import { applyAttentionOverrides, applyFilters, fetchAttention, needsAttentionCount, othersActivityAt, selectNotifications } from '../lib/poller.js';

const pr = (n, overrides = {}) => ({
  url: `https://github.com/acme/app/pull/${n}`,
  repo: 'acme/app',
  myStatus: 'red',
  title: `PR ${n}`,
  ...overrides,
});

describe('selectNotifications', () => {
  it('stays quiet on the first poll', () => {
    const { notify, lastNotifiedPRs } = selectNotifications([pr(1)], {}, {});
    expect(notify).toEqual([]);
    expect(lastNotifiedPRs).toEqual({ [pr(1).url]: 'red' });
  });

  it('notifies when a PR turns red', () => {
    const { notify } = selectNotifications([pr(1)], {}, { [pr(1).url]: 'green' });
    expect(notify.map((p) => p.url)).toEqual([pr(1).url]);
  });

  it('does not re-notify a PR that was already red', () => {
    const { notify } = selectNotifications([pr(1)], {}, { [pr(1).url]: 'red' });
    expect(notify).toEqual([]);
  });

  it('skips dismissed and self-requested PRs', () => {
    const last = { other: 'green' };
    const dismissed = { [pr(1).url]: { lastEventAt: 0 } };
    const { notify, lastNotifiedPRs } = selectNotifications([pr(1), pr(2, { selfRequested: true })], dismissed, last);
    expect(notify).toEqual([]);
    expect(lastNotifiedPRs).not.toHaveProperty(pr(1).url);
  });
});

describe('applyFilters', () => {
  const results = [pr(1), pr(2, { repo: 'acme/web' }), pr(3, { repo: 'other/lib' })];

  it('drops muted repos and owners', () => {
    const out = applyFilters(results, {}, { mutedRepos: ['acme/web'], mutedOwners: ['Other'] });
    expect(out.map((p) => p.repo)).toEqual(['acme/app']);
  });

  it('supports include and exclude lists', () => {
    expect(applyFilters(results, { repoFilterMode: 'include', repoFilterList: ['acme/app'] }, {})).toHaveLength(1);
    expect(applyFilters(results, { repoFilterMode: 'exclude', repoFilterList: ['acme/app'] }, {})).toHaveLength(2);
  });
});

describe('needsAttentionCount', () => {
  it('counts red, non-dismissed PRs', () => {
    const prs = [pr(1), pr(2), pr(3, { myStatus: 'green' })];
    expect(needsAttentionCount(prs, { [pr(2).url]: {} })).toBe(1);
  });
});

describe('fetchAttention', () => {
  it('puts a requested reviewer in the attention set', async () => {
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
      '/repos/acme/app/issues/7/timeline': [
        {
          event: 'review_requested',
          actor: { login: 'alice', type: 'User' },
          requested_reviewer: { login: 'me' },
          created_at: '2026-10-01T00:00:00Z',
        },
      ],
    };
    const fetcher = async (url) => {
      const path = new URL(url).pathname;
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => responses[path] };
    };

    const { username, results } = await fetchAttention('t', { debounceMinutes: 10 }, { fetcher });
    expect(username).toBe('me');
    expect(results[0]).toMatchObject({ repo: 'acme/app', myStatus: 'red', myRole: 'incoming', incomingDetail: 'new' });
  });
});

describe('Not my turn', () => {
  const user = (login, type = 'User') => ({ login, type });
  const at = (iso) => new Date(iso).getTime();

  it('counts only human activity by others', () => {
    const timeline = [
      { event: 'reviewed', user: user('copilot', 'Bot'), submitted_at: '2026-10-25T05:47:00Z' },
      { event: 'commented', actor: user('me'), created_at: '2026-10-25T06:00:00Z' },
      { event: 'labeled', actor: user('bob'), created_at: '2026-10-25T07:00:00Z' },
      { event: 'reviewed', user: user('bob'), submitted_at: '2026-10-25T04:00:00Z' },
    ];
    expect(othersActivityAt(timeline, 'me')).toBe(at('2026-10-25T04:00:00Z'));
  });

  const prs = [pr(1, { attentionSet: { me: 'red', bob: 'red' }, othersActivityAt: 100 })];

  it('takes you out of the attention set until someone responds', () => {
    const { results, expired } = applyAttentionOverrides(prs, { [pr(1).url]: { at: 200 } }, 'me');
    expect(results[0]).toMatchObject({ myStatus: 'green', attentionSet: { bob: 'red' }, steppedOutAt: 200 });
    expect(expired).toEqual([]);
  });

  it('puts you back once someone responds after you stepped out', () => {
    const { results, expired } = applyAttentionOverrides(prs, { [pr(1).url]: { at: 50 } }, 'me');
    expect(results[0].myStatus).toBe('red');
    expect(expired).toEqual([pr(1).url]);
  });
});

describe('Not my turn never empties the set', () => {
  it('hands the turn to the author when you were the only one in it', () => {
    const prs = [pr(1, { author: 'alice', prState: 'APPROVED_NO_AUTOMERGE', attentionSet: { me: 'red' }, othersActivityAt: 0 })];
    const { results } = applyAttentionOverrides(prs, { [pr(1).url]: { at: 10 } }, 'me');
    expect(results[0].attentionSet).toEqual({ alice: 'red' });
  });

  it('lapses when you are the author and the only one with the turn', () => {
    const prs = [pr(1, { author: 'me', prState: 'REVIEWING', attentionSet: { me: 'red' }, othersActivityAt: 0 })];
    const { results, expired } = applyAttentionOverrides(prs, { [pr(1).url]: { at: 10 } }, 'me');
    expect(results[0].myStatus).toBe('red');
    expect(expired).toEqual([pr(1).url]);
  });
});
