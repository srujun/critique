import { describe, it, expect } from 'vitest';
import { buildDiff, buildRevisions, myLastReviewCommit } from '../lib/review.js';
import { isWaitingOn } from '../lib/threads.js';

const user = (login) => ({ login, type: 'User' });

describe('buildRevisions', () => {
  const timeline = [
    { event: 'committed', sha: 'c1', message: 'First\n\nbody', committer: { date: '2026-10-01T00:00:00Z' } },
    { event: 'reviewed', user: user('me'), state: 'commented', commit_id: 'c1', submitted_at: '2026-10-02T00:00:00Z' },
    { event: 'head_ref_force_pushed', actor: user('alice'), commit_id: 'c2', created_at: '2026-10-03T00:00:00Z' },
    { event: 'reviewed', user: user('bob'), state: 'approved', commit_id: 'c2', submitted_at: '2026-10-04T00:00:00Z' },
  ];

  it('lists commits, force-pushes, and reviewed commits oldest first, with the head last', () => {
    const revs = buildRevisions(timeline, [{ sha: 'c3', since: new Date('2026-10-05').getTime() }], 'c3', 'me');
    expect(revs.map((r) => r.sha)).toEqual(['c1', 'c2', 'c3']);
    expect(revs[0]).toMatchObject({ labels: ['First', 'you commented'], reviewedByMe: true, isHead: false });
    expect(revs[1].labels).toEqual(['force-pushed by alice', 'bob approved']);
    expect(revs[2].isHead).toBe(true);
  });

  it('orders by commit time, not review time', () => {
    const revs = buildRevisions(timeline, [], 'c2', 'me');
    expect(revs[0].at).toBe(new Date('2026-10-01T00:00:00Z').getTime());
  });

  it('finds my latest reviewed commit', () => {
    expect(myLastReviewCommit(timeline, 'me')).toBe('c1');
    expect(myLastReviewCommit(timeline, 'carol')).toBe(null);
  });
});

describe('buildDiff', () => {
  const pr = { base: { sha: 'main1' }, head: { sha: 'head2' } };
  const ok = (body) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => body });

  const makeFetcher = (routes) => async (url) => {
    const u = new URL(url);
    const key = u.pathname + (u.searchParams.get('ref') ? `@${u.searchParams.get('ref')}` : '');
    if (!(key in routes)) return { ok: false, status: 404, headers: { get: () => null } };
    return ok(routes[key]);
  };

  it('uses the PR merge base for the whole PR', async () => {
    const fetcher = makeFetcher({
      '/repos/a/b/compare/main1...head2': { merge_base_commit: { sha: 'mb' }, files: [{ filename: 'x.js', status: 'modified', sha: 'blob', patch: '@@ -1 +1 @@\n-a\n+b' }] },
    });
    const d = await buildDiff('a/b', pr, null, null, 't', { fetcher });
    expect(d).toMatchObject({ mode: 'patch', base: 'mb', head: 'head2' });
    expect(d.files[0]).toMatchObject({ name: 'x.js', oldRef: 'mb', newRef: 'head2', blobSha: 'blob' });
  });

  it('diffs directly when the older version is an ancestor', async () => {
    const fetcher = makeFetcher({ '/repos/a/direct/compare/old1...head2': { status: 'ahead', files: [] } });
    expect((await buildDiff('a/direct', pr, 'old1', null, 't', { fetcher })).mode).toBe('patch');
  });

  // Results are cached by repo and SHA, so each test uses its own repo name.
  it('compares touched files snapshot by snapshot after a rebase', async () => {
    const fetcher = makeFetcher({
      '/repos/a/snap/compare/old9...head2': { status: 'diverged', files: [{ filename: 'from-main.js' }] },
      '/repos/a/snap/compare/main1...old9': { files: [{ filename: 'pr.js' }, { filename: 'same.js' }] },
      '/repos/a/snap/compare/main1...head2': { files: [{ filename: 'pr.js', sha: 'blobNew' }, { filename: 'same.js', sha: 'blobSame' }] },
      '/repos/a/snap/contents/pr.js@old9': 'v1',
      '/repos/a/snap/contents/pr.js@head2': 'v2',
      '/repos/a/snap/contents/same.js@old9': 'same',
      '/repos/a/snap/contents/same.js@head2': 'same',
    });
    const d = await buildDiff('a/snap', pr, 'old9', null, 't', { fetcher });
    expect(d.mode).toBe('snapshot');
    // The base branch's own change (from-main.js) is left out, and unchanged files are dropped.
    expect(d.files).toEqual([
      { name: 'pr.js', prevName: null, status: 'modified', blobSha: 'blobNew', oldContents: 'v1', newContents: 'v2', oldRef: 'old9', newRef: 'head2', section: 'source' },
    ]);
  });
});

describe('isWaitingOn', () => {
  const thread = (...authors) => ({ isResolved: false, comments: authors.map((author) => ({ author })) });

  it('is waiting when someone else replied last in a thread I joined', () => {
    expect(isWaitingOn('me', 'alice', thread('me', 'alice'))).toBe(true);
  });

  it('is waiting on the PR author for any thread they have not answered', () => {
    expect(isWaitingOn('me', 'me', thread('bob'))).toBe(true);
  });

  it('is not waiting when I spoke last, it is resolved, or I am not involved', () => {
    expect(isWaitingOn('me', 'alice', thread('alice', 'me'))).toBe(false);
    expect(isWaitingOn('me', 'alice', { ...thread('me', 'alice'), isResolved: true })).toBe(false);
    expect(isWaitingOn('me', 'alice', thread('bob', 'alice'))).toBe(false);
  });

  it('ignores bots', () => {
    expect(isWaitingOn('me', 'alice', thread('me', 'copilot[bot]'))).toBe(false);
  });
});
