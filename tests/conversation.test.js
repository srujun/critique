import { describe, it, expect } from 'vitest';
import { normalizeItem } from '../lib/conversation.js';

describe('normalizeItem', () => {
  it('flattens reviews and lowercases their state', () => {
    const item = normalizeItem({
      __typename: 'PullRequestReview',
      id: 'R1',
      author: { login: 'alice' },
      state: 'CHANGES_REQUESTED',
      submittedAt: '2026-10-01T00:00:00Z',
      bodyHTML: '<p>fix</p>',
      url: 'u',
      commit: { oid: 'abc' },
      comments: { totalCount: 2 },
    });
    expect(item).toMatchObject({ kind: 'review', id: 'R1', author: 'alice', state: 'changes_requested', commit: 'abc', inlineComments: 2 });
  });

  it('skips unsubmitted (pending) reviews', () => {
    expect(normalizeItem({ __typename: 'PullRequestReview', state: 'PENDING', author: { login: 'me' } })).toBe(null);
  });

  it('names users, teams and bots in review requests', () => {
    const base = { __typename: 'ReviewRequestedEvent', actor: { login: 'alice' }, createdAt: 't' };
    expect(normalizeItem({ ...base, requestedReviewer: { login: 'bob' } }).text).toBe('requested a review from bob');
    expect(normalizeItem({ ...base, requestedReviewer: { name: 'platform' } }).text).toBe('requested a review from platform');
  });

  it('keeps commits and force-pushes for version links', () => {
    expect(
      normalizeItem({ __typename: 'PullRequestCommit', commit: { oid: 'c1', messageHeadline: 'Fix', committedDate: 't', author: { user: { login: 'alice' } } } }),
    ).toEqual({ kind: 'commit', author: 'alice', at: 't', sha: 'c1', message: 'Fix' });
    expect(
      normalizeItem({ __typename: 'HeadRefForcePushedEvent', actor: { login: 'alice' }, createdAt: 't', beforeCommit: { oid: 'a' }, afterCommit: { oid: 'b' } }),
    ).toEqual({ kind: 'force-push', author: 'alice', at: 't', before: 'a', after: 'b' });
  });

  it('ignores unknown item types', () => {
    expect(normalizeItem({ __typename: 'SomethingNew' })).toBe(null);
  });
});
