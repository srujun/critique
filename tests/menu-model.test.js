import { describe, it, expect } from 'vitest';
import { MAX_NEEDS, menuModel, prEntry, reasonFor } from '../lib/menu-model.js';

const pr = (n, overrides = {}) => ({
  url: `https://github.com/acme/app/pull/${n}`,
  repo: 'acme/app',
  number: n,
  title: `PR ${n}`,
  author: 'alice',
  myStatus: 'red',
  myRole: 'incoming',
  incomingDetail: 'new',
  lastEventAt: n,
  ...overrides,
});
const view = (results, extra = {}) => ({ username: 'me', results, dismissed: {}, dismissedClicked: {}, needsAttention: results.filter((r) => r.myStatus === 'red').length, lastPoll: 0, ...extra });

describe('reasonFor', () => {
  it('explains review requests and updates', () => {
    expect(reasonFor(pr(1), 'me')).toBe('Review requested');
    expect(reasonFor(pr(1, { incomingDetail: 'rereview' }), 'me')).toBe('Re-review requested');
    expect(reasonFor(pr(1, { incomingDetail: 'updated', sinceReview: { newCommits: 2 } }), 'me')).toBe('2 new commits since your review');
    expect(reasonFor(pr(1, { incomingDetail: 'updated', sinceReview: null }), 'me')).toBe('Author replied since your review');
  });

  it('explains your own PRs', () => {
    const mine = { myRole: 'outgoing', author: 'me' };
    expect(reasonFor(pr(1, { ...mine, prState: 'CHANGES_REQUESTED', reviewerStates: { bob: 'changes_requested', cy: 'approved' } }), 'me')).toBe(
      'Changes requested by bob',
    );
    expect(reasonFor(pr(1, { ...mine, prState: 'APPROVED_NO_AUTOMERGE' }), 'me')).toBe('Approved, ready to merge');
  });

  it('says who a waiting PR is waiting on', () => {
    expect(reasonFor(pr(1, { myStatus: 'green', attentionSet: { bob: 'red', cy: 'red', me: 'green' } }), 'me')).toBe('Waiting on bob and cy');
  });
});

describe('prEntry', () => {
  it('offers a since-your-review action only when there is one', () => {
    const plain = prEntry(pr(1), view([]));
    expect(plain.actions.map((a) => a.label)).toEqual([
      'Review in Critique',
      'Open on GitHub',
      undefined,
      'Not My Turn Until Someone Responds',
      'Copy Link',
      'Dismiss',
      'Mute acme/app',
    ]);
    const updated = prEntry(pr(1, { sinceReview: { base: 'sha1', newCommits: 3 } }), view([]));
    expect(updated.actions[1]).toMatchObject({ label: 'Review Changes Since Your Review (3 commits)', action: { kind: 'review', query: 'repo=acme%2Fapp&number=1&base=sha1' } });
  });

  it('puts the reason, waiting threads and PR number in the subtitle', () => {
    const entry = prEntry(pr(7, { threads: { waitingOnMe: 2 } }), view([]));
    expect(entry.sublabel).toBe('Review requested · 2 threads waiting on you · app#7');
    expect(entry.dot).toBe('red');
  });

  it('uses a hollow dot once you have opened it since its last activity', () => {
    expect(prEntry(pr(7), view([], { dismissedClicked: { [pr(7).url]: 100 } })).dot).toBe('red-seen');
  });
});

describe('menuModel', () => {
  it('shows the count in the menu bar title and caps the list', () => {
    const results = Array.from({ length: MAX_NEEDS + 3 }, (_, i) => pr(i + 1));
    const model = menuModel(view(results));
    expect(model.title).toBe(String(MAX_NEEDS + 3));
    expect(model.needs).toHaveLength(MAX_NEEDS);
    expect(model.needsMore).toBe(3);
    expect(model.needs[0].label).toBe(`PR ${MAX_NEEDS + 3}`); // most recent first
  });

  it('leaves dismissed PRs out and splits waiting ones off', () => {
    const results = [pr(1), pr(2, { myStatus: 'green' }), pr(3)];
    const model = menuModel(view(results, { dismissed: { [pr(3).url]: {} } }));
    expect(model.needs.map((e) => e.label)).toEqual(['PR 1']);
    expect(model.waiting.map((e) => e.label)).toEqual(['PR 2']);
  });

  it('flags auth problems in the menu bar', () => {
    const model = menuModel(view([], { lastError: { type: 'auth' } }));
    expect(model.title).toBe('!');
    expect(model.error).toBe('GitHub token missing or rejected');
  });
});

describe('Not my turn', () => {
  it('explains the step-out and offers to undo it', () => {
    const entry = prEntry(pr(1, { myStatus: 'green', steppedOutAt: 5 }), view([]));
    expect(entry.sublabel.startsWith('Not your turn until someone responds')).toBe(true);
    expect(entry.actions.map((a) => a.label)).toContain('Back to My Turn');
    expect(entry.actions.map((a) => a.label)).not.toContain('Not My Turn Until Someone Responds');
  });
});

describe('canStepOut', () => {
  it('is not offered on your own PR when nobody else has the turn', () => {
    const lonely = prEntry(pr(1, { author: 'me', myRole: 'outgoing', attentionSet: { me: 'red' } }), view([]));
    expect(lonely.actions.map((a) => a.label)).not.toContain('Not My Turn Until Someone Responds');
  });
});
