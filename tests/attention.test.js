import { describe, it, expect } from 'vitest';
import { computeAttentionSet, isBot } from '../lib/attention.js';

const DEBOUNCE_MIN = 10;
const DEBOUNCE_MS = DEBOUNCE_MIN * 60 * 1000;

function minutesAgo(n, now) {
  return new Date(now - n * 60 * 1000).toISOString();
}

function hoursAgo(n, now) {
  return new Date(now - n * 60 * 60 * 1000).toISOString();
}

describe('computeAttentionSet', () => {
  const NOW = Date.now();
  const author = 'alice';
  const reviewer = 'bob';

  describe('State: REVIEWING', () => {
    it('review_requested → reviewer in attention set', () => {
      const timeline = [
        {
          event: 'review_requested',
          actor: { login: author },
          requested_reviewer: { login: reviewer },
          created_at: minutesAgo(5, NOW),
        },
      ];
      const result = computeAttentionSet(timeline, 'charlie', author, DEBOUNCE_MIN, NOW);
      expect(result.set[reviewer]).toBe('red');
      expect(result.set[author]).toBeUndefined();
    });

    it('fresh PR with review request → reviewer red', () => {
      const timeline = [
        {
          event: 'review_requested',
          actor: { login: author },
          requested_reviewer: { login: reviewer },
          created_at: minutesAgo(1, NOW),
        },
      ];
      const result = computeAttentionSet(timeline, reviewer, author, DEBOUNCE_MIN, NOW);
      expect(result.set[reviewer]).toBe('red');
      expect(result.myStatus).toBe('red');
    });

    it('multiple reviewers tracked independently', () => {
      const timeline = [
        {
          event: 'review_requested',
          actor: { login: author },
          requested_reviewer: { login: 'bob' },
          created_at: minutesAgo(30, NOW),
        },
        {
          event: 'review_requested',
          actor: { login: author },
          requested_reviewer: { login: 'carol' },
          created_at: minutesAgo(29, NOW),
        },
      ];
      const result = computeAttentionSet(timeline, 'carol', author, DEBOUNCE_MIN, NOW);
      expect(result.set['bob']).toBe('red');
      expect(result.set['carol']).toBe('red');
      expect(result.myStatus).toBe('red');
    });

    it('reviewer submits review → leaves attention set', () => {
      const timeline = [
        {
          event: 'review_requested',
          actor: { login: author },
          requested_reviewer: { login: reviewer },
          created_at: minutesAgo(30, NOW),
        },
        { event: 'reviewed', actor: { login: reviewer }, state: 'commented', submitted_at: minutesAgo(20, NOW) },
      ];
      // After reviewed state=commented, state becomes COMMENTED, author in set
      const result = computeAttentionSet(timeline, reviewer, author, DEBOUNCE_MIN, NOW);
      expect(result.set[reviewer]).toBeUndefined();
      expect(result.myStatus).toBe('green');
    });

    it('author re-requests review after changes → REVIEWING', () => {
      const timeline = [
        {
          event: 'review_requested',
          actor: { login: author },
          requested_reviewer: { login: reviewer },
          created_at: minutesAgo(60, NOW),
        },
        {
          event: 'reviewed',
          actor: { login: reviewer },
          state: 'changes_requested',
          submitted_at: minutesAgo(50, NOW),
        },
        { event: 'committed', actor: { login: author }, committer: { login: author }, created_at: minutesAgo(40, NOW) },
        {
          event: 'review_requested',
          actor: { login: author },
          requested_reviewer: { login: reviewer },
          created_at: minutesAgo(30, NOW),
        },
      ];
      const result = computeAttentionSet(timeline, author, author, DEBOUNCE_MIN, NOW);
      expect(result.set[reviewer]).toBe('red');
      expect(result.set[author]).toBeUndefined();
      expect(result.myStatus).toBe('green');
    });
  });

  describe('State: DRAFT', () => {
    it('convert_to_draft → nobody in set', () => {
      const timeline = [
        {
          event: 'review_requested',
          actor: { login: author },
          requested_reviewer: { login: reviewer },
          created_at: minutesAgo(30, NOW),
        },
        { event: 'convert_to_draft', actor: { login: author }, created_at: minutesAgo(20, NOW) },
      ];
      const result = computeAttentionSet(timeline, reviewer, author, DEBOUNCE_MIN, NOW);
      expect(result.set).toEqual({});
      expect(result.myStatus).toBe('green');
    });

    it('ready_for_review after draft → REVIEWING', () => {
      const timeline = [
        { event: 'convert_to_draft', actor: { login: author }, created_at: minutesAgo(30, NOW) },
        { event: 'ready_for_review', actor: { login: author }, created_at: minutesAgo(20, NOW) },
        {
          event: 'review_requested',
          actor: { login: author },
          requested_reviewer: { login: reviewer },
          created_at: minutesAgo(19, NOW),
        },
      ];
      const result = computeAttentionSet(timeline, reviewer, author, DEBOUNCE_MIN, NOW);
      expect(result.set[reviewer]).toBe('red');
      expect(result.myStatus).toBe('red');
    });
  });

  describe('State: CHANGES_REQUESTED', () => {
    it('changes_requested → author in set', () => {
      const timeline = [
        {
          event: 'review_requested',
          actor: { login: author },
          requested_reviewer: { login: reviewer },
          created_at: minutesAgo(30, NOW),
        },
        {
          event: 'reviewed',
          actor: { login: reviewer },
          state: 'changes_requested',
          submitted_at: minutesAgo(20, NOW),
        },
      ];
      const result = computeAttentionSet(timeline, author, author, DEBOUNCE_MIN, NOW);
      expect(result.set[author]).toBe('red');
      expect(result.myStatus).toBe('red');
    });

    it('commit without re-request stays in CHANGES_REQUESTED', () => {
      const timeline = [
        {
          event: 'reviewed',
          actor: { login: reviewer },
          state: 'changes_requested',
          submitted_at: minutesAgo(30, NOW),
        },
        { event: 'committed', actor: { login: author }, committer: { login: author }, created_at: minutesAgo(20, NOW) },
      ];
      const result = computeAttentionSet(timeline, author, author, DEBOUNCE_MIN, NOW);
      expect(result.set[author]).toBe('red');
      expect(result.myStatus).toBe('red');
    });
  });

  describe('State: COMMENTED (debounce)', () => {
    it('comment past debounce → author red', () => {
      const timeline = [
        { event: 'reviewed', actor: { login: reviewer }, state: 'commented', submitted_at: minutesAgo(15, NOW) },
      ];
      const result = computeAttentionSet(timeline, author, author, DEBOUNCE_MIN, NOW);
      expect(result.set[author]).toBe('red');
      expect(result.myStatus).toBe('red');
    });

    it('comment within debounce → author yellow', () => {
      const timeline = [
        { event: 'reviewed', actor: { login: reviewer }, state: 'commented', submitted_at: minutesAgo(5, NOW) },
      ];
      const result = computeAttentionSet(timeline, author, author, DEBOUNCE_MIN, NOW);
      expect(result.set[author]).toBe('yellow');
      expect(result.myStatus).toBe('yellow');
    });

    it('debounce boundary — exactly at debounce time → red', () => {
      const exactlyAtBoundary = new Date(NOW - DEBOUNCE_MS).toISOString();
      const timeline = [
        { event: 'reviewed', actor: { login: reviewer }, state: 'commented', submitted_at: exactlyAtBoundary },
      ];
      const result = computeAttentionSet(timeline, author, author, DEBOUNCE_MIN, NOW);
      expect(result.set[author]).toBe('red');
    });

    it('debounce boundary — 1ms before → yellow', () => {
      const justBefore = new Date(NOW - DEBOUNCE_MS + 1).toISOString();
      const timeline = [
        { event: 'reviewed', actor: { login: reviewer }, state: 'commented', submitted_at: justBefore },
      ];
      const result = computeAttentionSet(timeline, author, author, DEBOUNCE_MIN, NOW);
      expect(result.set[author]).toBe('yellow');
    });
  });

  describe('State: APPROVED_NO_AUTOMERGE', () => {
    it('approved without auto-merge → author red', () => {
      const timeline = [
        {
          event: 'review_requested',
          actor: { login: author },
          requested_reviewer: { login: reviewer },
          created_at: minutesAgo(30, NOW),
        },
        { event: 'reviewed', actor: { login: reviewer }, state: 'approved', submitted_at: minutesAgo(10, NOW) },
      ];
      const result = computeAttentionSet(timeline, author, author, DEBOUNCE_MIN, NOW);
      expect(result.set[author]).toBe('red');
      expect(result.myStatus).toBe('red');
    });
  });

  describe('State: MERGING', () => {
    it('approved + auto-merge + recent activity → nobody in set', () => {
      const timeline = [
        {
          event: 'review_requested',
          actor: { login: author },
          requested_reviewer: { login: reviewer },
          created_at: minutesAgo(60, NOW),
        },
        { event: 'auto_squash_enabled', actor: { login: reviewer }, created_at: minutesAgo(10, NOW) },
        { event: 'reviewed', actor: { login: reviewer }, state: 'approved', submitted_at: minutesAgo(9, NOW) },
      ];
      const result = computeAttentionSet(timeline, author, author, DEBOUNCE_MIN, NOW);
      expect(result.set).toEqual({});
      expect(result.myStatus).toBe('green');
    });

    it('auto-merge enabled after approval → MERGING', () => {
      const timeline = [
        { event: 'reviewed', actor: { login: reviewer }, state: 'approved', submitted_at: minutesAgo(20, NOW) },
        { event: 'auto_squash_enabled', actor: { login: reviewer }, created_at: minutesAgo(19, NOW) },
      ];
      const result = computeAttentionSet(timeline, author, author, DEBOUNCE_MIN, NOW);
      expect(result.set).toEqual({});
      expect(result.myStatus).toBe('green');
    });
  });

  describe('State: STALLED_MERGE', () => {
    it('approved + auto-merge + no activity > 24h → author red', () => {
      const timeline = [
        { event: 'auto_merge_enabled', actor: { login: author }, created_at: hoursAgo(48, NOW) },
        { event: 'reviewed', actor: { login: reviewer }, state: 'approved', submitted_at: hoursAgo(36, NOW) },
      ];
      const result = computeAttentionSet(timeline, author, author, DEBOUNCE_MIN, NOW);
      expect(result.set[author]).toBe('red');
      expect(result.myStatus).toBe('red');
    });

    it('auto-merge on but activity within 24h → MERGING (green)', () => {
      const timeline = [
        { event: 'auto_merge_enabled', actor: { login: author }, created_at: hoursAgo(48, NOW) },
        { event: 'reviewed', actor: { login: reviewer }, state: 'approved', submitted_at: hoursAgo(2, NOW) },
      ];
      const result = computeAttentionSet(timeline, author, author, DEBOUNCE_MIN, NOW);
      expect(result.set).toEqual({});
      expect(result.myStatus).toBe('green');
    });
  });

  describe('State: MERGED / CLOSED', () => {
    it('merged → nobody in set', () => {
      const timeline = [
        {
          event: 'reviewed',
          actor: { login: reviewer },
          state: 'changes_requested',
          submitted_at: minutesAgo(30, NOW),
        },
        { event: 'merged', actor: { login: author }, created_at: minutesAgo(5, NOW) },
      ];
      const result = computeAttentionSet(timeline, author, author, DEBOUNCE_MIN, NOW);
      expect(result.set).toEqual({});
      expect(result.myStatus).toBe('green');
    });

    it('closed → nobody in set', () => {
      const timeline = [
        {
          event: 'reviewed',
          actor: { login: reviewer },
          state: 'changes_requested',
          submitted_at: minutesAgo(30, NOW),
        },
        { event: 'closed', actor: { login: author }, created_at: minutesAgo(5, NOW) },
      ];
      const result = computeAttentionSet(timeline, author, author, DEBOUNCE_MIN, NOW);
      expect(result.set).toEqual({});
      expect(result.myStatus).toBe('green');
    });
  });

  describe('Additional rules', () => {
    it('@mention → that person enters set regardless of state', () => {
      const timeline = [
        {
          event: 'commented',
          actor: { login: reviewer },
          created_at: minutesAgo(30, NOW),
          body: 'Hey @charlie can you take a look?',
        },
      ];
      const result = computeAttentionSet(timeline, 'charlie', author, DEBOUNCE_MIN, NOW);
      expect(result.set['charlie']).toBe('red');
      expect(result.myStatus).toBe('red');
    });

    it('assigned (non-author) → enters set', () => {
      const timeline = [
        { event: 'assigned', actor: { login: author }, assignee: { login: 'dave' }, created_at: minutesAgo(10, NOW) },
      ];
      const result = computeAttentionSet(timeline, 'dave', author, DEBOUNCE_MIN, NOW);
      expect(result.set['dave']).toBe('red');
      expect(result.myStatus).toBe('red');
    });

    it('review_request_removed → reviewer leaves', () => {
      const timeline = [
        {
          event: 'review_requested',
          actor: { login: author },
          requested_reviewer: { login: reviewer },
          created_at: minutesAgo(30, NOW),
        },
        {
          event: 'review_request_removed',
          actor: { login: author },
          requested_reviewer: { login: reviewer },
          created_at: minutesAgo(20, NOW),
        },
      ];
      const result = computeAttentionSet(timeline, reviewer, author, DEBOUNCE_MIN, NOW);
      expect(result.set[reviewer]).toBeUndefined();
      expect(result.myStatus).toBe('green');
    });

    it('bot comments do not affect attention set', () => {
      const timeline = [
        {
          event: 'review_requested',
          actor: { login: author, type: 'User' },
          requested_reviewer: { login: reviewer, type: 'User' },
          created_at: minutesAgo(30, NOW),
        },
        {
          event: 'commented',
          actor: { login: 'codecov[bot]', type: 'Bot' },
          user: { login: 'codecov[bot]', type: 'Bot' },
          created_at: minutesAgo(20, NOW),
          body: '@alice coverage dropped',
        },
      ];
      const result = computeAttentionSet(timeline, author, author, DEBOUNCE_MIN, NOW);
      // Bot mention should be ignored, state stays REVIEWING, author not in set
      expect(result.set[author]).toBeUndefined();
      expect(result.set[reviewer]).toBe('red');
    });

    it('auto_merge_disabled → APPROVED_NO_AUTOMERGE if previously approved', () => {
      const timeline = [
        { event: 'auto_merge_enabled', actor: { login: author }, created_at: minutesAgo(60, NOW) },
        { event: 'reviewed', actor: { login: reviewer }, state: 'approved', submitted_at: minutesAgo(50, NOW) },
        { event: 'auto_merge_disabled', actor: { login: author }, created_at: minutesAgo(40, NOW) },
      ];
      // After auto_merge_disabled, autoMerge is off. State was MERGING from approved,
      // but post-processing won't upgrade since autoMerge is now off.
      // Actually: at the time of 'reviewed approved', autoMerge was active → MERGING.
      // Then auto_merge_disabled sets autoMerge inactive.
      // Post-processing: prState is MERGING but autoMergeActive is false now...
      // Hmm, let me re-check. The state is set at reviewed time. After that auto_merge_disabled
      // doesn't change prState. We need to handle this.
      // Actually looking at the code: after the loop, if prState is APPROVED_NO_AUTOMERGE and autoMerge active,
      // we upgrade. But we don't downgrade MERGING if autoMerge goes inactive.
      // This is a valid scenario - let me adjust the implementation.
      const result = computeAttentionSet(timeline, author, author, DEBOUNCE_MIN, NOW);
      // With current impl, prState = MERGING (set at approved time), but autoMerge off after.
      // Need to handle: if prState is MERGING/STALLED but autoMerge is now off → APPROVED_NO_AUTOMERGE
      expect(result.set[author]).toBe('red');
      expect(result.myStatus).toBe('red');
    });
  });

  describe('Edge cases', () => {
    it('empty timeline → only the author (the set is never empty on an active PR)', () => {
      const result = computeAttentionSet([], 'me', author, DEBOUNCE_MIN, NOW);
      expect(result.set).toEqual({ [author]: 'red' });
      expect(result.myStatus).toBe('green');
    });

    it('comment by author does not put author in attention set in REVIEWING state', () => {
      const timeline = [
        { event: 'review_requested', actor: { login: author }, requested_reviewer: { login: 'bob' }, created_at: minutesAgo(60, NOW) },
        { event: 'commented', actor: { login: author }, created_at: minutesAgo(30, NOW), body: 'I fixed this' },
      ];
      const result = computeAttentionSet(timeline, author, author, DEBOUNCE_MIN, NOW);
      expect(result.set).toEqual({ bob: 'red' });
      expect(result.myStatus).toBe('green');
    });

    it('review_requested with team does not add team to set', () => {
      const timeline = [
        {
          event: 'review_requested',
          actor: { login: author, type: 'User' },
          requested_team: { name: 'sig-approvers' },
          created_at: minutesAgo(10, NOW),
        },
      ];
      const result = computeAttentionSet(timeline, author, author, DEBOUNCE_MIN, NOW);
      expect(result.set).not.toHaveProperty('sig-approvers');
    });
  });

  describe('Real PR #1056: approve + auto_squash_enabled', () => {
    it('full timeline → green (MERGING state)', () => {
      const timeline = [
        {
          event: 'review_requested',
          actor: { login: 'justinchuby', type: 'User' },
          requested_team: { name: 'onnxruntime-extensions' },
          created_at: '2026-05-06T16:42:50Z',
        },
        {
          event: 'review_requested',
          actor: { login: 'justinchuby', type: 'User' },
          requested_reviewer: { login: 'Copilot', type: 'Bot' },
          created_at: '2026-05-06T16:42:50Z',
        },
        {
          event: 'head_ref_force_pushed',
          actor: { login: 'justinchuby', type: 'User' },
          created_at: '2026-05-06T16:51:59Z',
        },
        {
          event: 'head_ref_force_pushed',
          actor: { login: 'justinchuby', type: 'User' },
          created_at: '2026-05-06T16:57:07Z',
        },
        {
          event: 'committed',
          actor: { login: 'justinchuby', type: 'User' },
          committer: { login: 'justinchuby' },
          created_at: '2026-05-06T17:02:22Z',
        },
        {
          event: 'commented',
          actor: { login: 'justinchuby', type: 'User' },
          user: { login: 'justinchuby', type: 'User' },
          created_at: '2026-05-06T17:13:24Z',
          body: '@sayanshaw24 @apsonawane',
        },
        {
          event: 'reviewed',
          actor: { login: 'sayanshaw24', type: 'User' },
          user: { login: 'sayanshaw24', type: 'User' },
          state: 'commented',
          submitted_at: '2026-05-06T18:11:42Z',
        },
        {
          event: 'reviewed',
          actor: { login: 'sayanshaw24', type: 'User' },
          user: { login: 'sayanshaw24', type: 'User' },
          state: 'commented',
          submitted_at: '2026-05-06T18:14:41Z',
        },
        {
          event: 'reviewed',
          actor: { login: 'sayanshaw24', type: 'User' },
          user: { login: 'sayanshaw24', type: 'User' },
          state: 'commented',
          submitted_at: '2026-05-06T18:17:38Z',
        },
        {
          event: 'commented',
          actor: { login: 'sayanshaw24', type: 'User' },
          user: { login: 'sayanshaw24', type: 'User' },
          created_at: '2026-05-06T18:22:51Z',
        },
        {
          event: 'committed',
          actor: { login: 'justinchuby', type: 'User' },
          committer: { login: 'justinchuby' },
          created_at: '2026-05-06T21:19:23Z',
        },
        {
          event: 'commented',
          actor: { login: 'justinchuby', type: 'User' },
          user: { login: 'justinchuby', type: 'User' },
          created_at: '2026-05-06T21:19:43Z',
        },
        {
          event: 'commented',
          actor: { login: 'justinchuby', type: 'User' },
          user: { login: 'justinchuby', type: 'User' },
          created_at: '2026-05-06T21:25:45Z',
        },
        {
          event: 'committed',
          actor: { login: 'justinchuby', type: 'User' },
          committer: { login: 'justinchuby' },
          created_at: '2026-05-06T21:29:46Z',
        },
        {
          event: 'review_requested',
          actor: { login: 'justinchuby', type: 'User' },
          requested_reviewer: { login: 'sayanshaw24', type: 'User' },
          created_at: '2026-05-06T23:58:53Z',
        },
        {
          event: 'committed',
          actor: { login: 'justinchuby', type: 'User' },
          committer: { login: 'justinchuby' },
          created_at: '2026-05-07T00:04:15Z',
        },
        {
          event: 'commented',
          actor: { login: 'justinchuby', type: 'User' },
          user: { login: 'justinchuby', type: 'User' },
          created_at: '2026-05-07T00:05:16Z',
        },
        {
          event: 'auto_squash_enabled',
          actor: { login: 'sayanshaw24', type: 'User' },
          created_at: '2026-05-07T00:18:25Z',
        },
        {
          event: 'reviewed',
          actor: { login: 'sayanshaw24', type: 'User' },
          user: { login: 'sayanshaw24', type: 'User' },
          state: 'approved',
          submitted_at: '2026-05-07T00:18:28Z',
        },
      ];
      const result = computeAttentionSet(
        timeline,
        'justinchuby',
        'justinchuby',
        10,
        new Date('2026-05-07T01:00:00Z').getTime(),
      );
      expect(result.myStatus).toBe('green');
      expect(result.set['justinchuby']).toBeUndefined();
    });
  });
});

describe('isBot', () => {
  it('detects [bot] suffix', () => {
    expect(isBot('github-actions[bot]')).toBe(true);
    expect(isBot('dependabot[bot]')).toBe(true);
    expect(isBot('renovate[bot]')).toBe(true);
  });

  it('detects Bot type from user object', () => {
    expect(isBot('some-app', { type: 'Bot' })).toBe(true);
  });

  it('does not flag regular users', () => {
    expect(isBot('alice')).toBe(false);
    expect(isBot('bob', { type: 'User' })).toBe(false);
  });

  it('bots without suffix or type are not detected (no hardcoded list)', () => {
    // Without [bot] suffix or type:Bot, plain usernames are not detected as bots
    expect(isBot('dependabot')).toBe(false);
    expect(isBot('renovate')).toBe(false);
    expect(isBot('codecov')).toBe(false);
    // But with type info they are
    expect(isBot('dependabot', { type: 'Bot' })).toBe(true);
  });

  it('detects numeric-only logins', () => {
    expect(isBot('12345')).toBe(true);
  });
});

it('user requested to review shows REVIEWING reason even if PR is approved', () => {
  const timeline = [
    {
      event: 'review_requested',
      actor: { login: 'author', type: 'User' },
      requested_reviewer: { login: 'me', type: 'User' },
      created_at: '2026-01-01T00:00:00Z',
    },
    {
      event: 'reviewed',
      actor: { login: 'other-reviewer', type: 'User' },
      user: { login: 'other-reviewer', type: 'User' },
      state: 'approved',
      submitted_at: '2026-01-02T00:00:00Z',
    },
  ];
  const result = computeAttentionSet(timeline, 'me', 'author', 10, new Date('2026-01-03').getTime());
  expect(result.myStatus).toBe('red');
  expect(result.myReason).toBe('REVIEWING');
});

it('user who already reviewed does not get REVIEWING reason', () => {
  const timeline = [
    {
      event: 'review_requested',
      actor: { login: 'author', type: 'User' },
      requested_reviewer: { login: 'me', type: 'User' },
      created_at: '2026-01-01T00:00:00Z',
    },
    {
      event: 'reviewed',
      actor: { login: 'me', type: 'User' },
      user: { login: 'me', type: 'User' },
      state: 'commented',
      submitted_at: '2026-01-02T00:00:00Z',
    },
    {
      event: 'reviewed',
      actor: { login: 'other', type: 'User' },
      user: { login: 'other', type: 'User' },
      state: 'approved',
      submitted_at: '2026-01-03T00:00:00Z',
    },
  ];
  const result = computeAttentionSet(timeline, 'me', 'author', 10, new Date('2026-01-04').getTime());
  // me already reviewed, so reason follows prState not REVIEWING
  expect(result.myReason).not.toBe('REVIEWING');
});

it('re-requested review after user already reviewed shows REVIEWING', () => {
  const timeline = [
    {
      event: 'review_requested',
      actor: { login: 'author', type: 'User' },
      requested_reviewer: { login: 'me', type: 'User' },
      created_at: '2026-01-01T00:00:00Z',
    },
    {
      event: 'reviewed',
      actor: { login: 'me', type: 'User' },
      user: { login: 'me', type: 'User' },
      state: 'commented',
      submitted_at: '2026-01-02T00:00:00Z',
    },
    {
      event: 'review_requested',
      actor: { login: 'author', type: 'User' },
      requested_reviewer: { login: 'me', type: 'User' },
      created_at: '2026-01-03T00:00:00Z',
    },
  ];
  const result = computeAttentionSet(timeline, 'me', 'author', 10, new Date('2026-01-04').getTime());
  expect(result.myStatus).toBe('red');
  expect(result.myReason).toBe('REVIEWING');
});

describe('bot comment handling', () => {
  it('bot comment (not in reviewer list) does not give author attention', () => {
    const timeline = [
      { event: 'review_requested', actor: { login: 'alice' }, requested_reviewer: { login: 'bob' }, created_at: '2026-05-01T09:00:00Z' },
      {
        event: 'reviewed',
        actor: { login: 'codecov[bot]', type: 'Bot' },
        state: 'commented',
        submitted_at: '2026-05-01T10:00:00Z',
        body: 'Coverage report',
      },
    ];
    const result = computeAttentionSet(timeline, 'alice', 'alice', 10);
    expect(result.myStatus).toBe('green');
    expect(result.set).toEqual({ bob: 'red' });
  });

  it('bot requested as reviewer is treated normally', () => {
    const timeline = [
      {
        event: 'review_requested',
        actor: { login: 'alice' },
        requested_reviewer: { login: 'copilot[bot]', type: 'Bot' },
        created_at: '2026-05-01T09:00:00Z',
      },
      {
        event: 'reviewed',
        actor: { login: 'copilot[bot]', type: 'Bot' },
        state: 'commented',
        submitted_at: '2026-05-01T10:00:00Z',
        body: 'Suggestions',
      },
    ];
    const result = computeAttentionSet(timeline, 'alice', 'alice', 10);
    // Bot was requested reviewer and commented — author gets attention (COMMENTED state)
    expect(result.set['alice']).toBe('red');
    expect(result.allReviewers).toContain('copilot[bot]');
    expect(result.reviewerStates['copilot[bot]']).toBe('commented');
  });

  it('bot comment without being reviewer does not appear in allReviewers', () => {
    const timeline = [
      { event: 'review_requested', actor: { login: 'alice' }, requested_reviewer: { login: 'carol' }, created_at: '2026-05-01T09:00:00Z' },
      {
        event: 'reviewed',
        actor: { login: 'stale[bot]', type: 'Bot' },
        state: 'commented',
        submitted_at: '2026-05-01T10:00:00Z',
        body: 'This issue is stale',
      },
    ];
    const result = computeAttentionSet(timeline, 'bob', 'alice', 10);
    expect(result.allReviewers).not.toContain('stale[bot]');
    expect(result.set['alice']).toBeUndefined();
  });
});

describe('team review requests', () => {
  const NOW = Date.now();
  function minutesAgo(n) {
    return new Date(NOW - n * 60 * 1000).toISOString();
  }

  it('team review request adds me to attention set (onlyDirectRequests=false)', () => {
    const timeline = [
      {
        event: 'review_requested',
        actor: { login: 'alice' },
        requested_team: { name: 'frontend', slug: 'frontend' },
        created_at: minutesAgo(5),
      },
    ];
    const result = computeAttentionSet(timeline, 'bob', 'alice', 10, NOW, {
      onlyDirectRequests: false,
    });
    expect(result.set['bob']).toBe('red');
  });

  it('team review request respects onlyDirectRequests=true', () => {
    const timeline = [
      {
        event: 'review_requested',
        actor: { login: 'alice' },
        requested_team: { name: 'frontend', slug: 'frontend' },
        created_at: minutesAgo(5),
      },
    ];
    const result = computeAttentionSet(timeline, 'bob', 'alice', 10, NOW, {
      onlyDirectRequests: true,
      whitelistedTeams: [],
    });
    expect(result.set['bob']).toBeUndefined();
  });

  it('whitelisted team adds me even with onlyDirectRequests=true', () => {
    const timeline = [
      {
        event: 'review_requested',
        actor: { login: 'alice' },
        requested_team: { name: 'core-team', slug: 'core-team' },
        created_at: minutesAgo(5),
      },
    ];
    const result = computeAttentionSet(timeline, 'bob', 'alice', 10, NOW, {
      onlyDirectRequests: true,
      whitelistedTeams: ['core-team'],
    });
    expect(result.set['bob']).toBe('red');
  });

  it('team removal removes me from attention set', () => {
    const timeline = [
      {
        event: 'review_requested',
        actor: { login: 'alice' },
        requested_team: { name: 'frontend', slug: 'frontend' },
        created_at: minutesAgo(10),
      },
      {
        event: 'review_request_removed',
        actor: { login: 'alice' },
        requested_team: { name: 'frontend', slug: 'frontend' },
        created_at: minutesAgo(5),
      },
    ];
    const result = computeAttentionSet(timeline, 'bob', 'alice', 10, NOW, {
      onlyDirectRequests: false,
    });
    expect(result.set['bob']).toBeUndefined();
  });

  it('myRole = incoming for team-based requests', () => {
    const timeline = [
      {
        event: 'review_requested',
        actor: { login: 'alice' },
        requested_team: { name: 'frontend', slug: 'frontend' },
        created_at: minutesAgo(5),
      },
    ];
    const result = computeAttentionSet(timeline, 'bob', 'alice', 10, NOW, {
      onlyDirectRequests: false,
    });
    expect(result.myRole).toBe('incoming');
  });

  it('incomingDetail = new for team-based requests', () => {
    const timeline = [
      {
        event: 'review_requested',
        actor: { login: 'alice' },
        requested_team: { name: 'frontend', slug: 'frontend' },
        created_at: minutesAgo(5),
      },
    ];
    const result = computeAttentionSet(timeline, 'bob', 'alice', 10, NOW, {
      onlyDirectRequests: false,
    });
    expect(result.incomingDetail).toBe('new');
  });
});

describe('incomingDetail classification', () => {
  const NOW = Date.now();
  function minutesAgo(n) {
    return new Date(NOW - n * 60 * 1000).toISOString();
  }

  it('incomingDetail = new for first review request', () => {
    const timeline = [
      {
        event: 'review_requested',
        actor: { login: 'alice' },
        requested_reviewer: { login: 'bob' },
        created_at: minutesAgo(5),
      },
    ];
    const result = computeAttentionSet(timeline, 'bob', 'alice', 10, NOW);
    expect(result.incomingDetail).toBe('new');
  });

  it('incomingDetail = updated when author responded after review', () => {
    const timeline = [
      {
        event: 'review_requested',
        actor: { login: 'alice' },
        requested_reviewer: { login: 'bob' },
        created_at: minutesAgo(30),
      },
      {
        event: 'reviewed',
        actor: { login: 'bob' },
        state: 'changes_requested',
        submitted_at: minutesAgo(20),
      },
      {
        event: 'committed',
        actor: { login: 'alice' },
        created_at: minutesAgo(10),
      },
      {
        event: 'review_requested',
        actor: { login: 'alice' },
        requested_reviewer: { login: 'bob' },
        created_at: minutesAgo(5),
      },
    ];
    const result = computeAttentionSet(timeline, 'bob', 'alice', 10, NOW);
    expect(result.incomingDetail).toBe('rereview');
  });

  it('incomingDetail = rereview when re-requested after submitting review', () => {
    const timeline = [
      {
        event: 'review_requested',
        actor: { login: 'alice' },
        requested_reviewer: { login: 'bob' },
        created_at: minutesAgo(30),
      },
      {
        event: 'reviewed',
        actor: { login: 'bob' },
        state: 'commented',
        submitted_at: minutesAgo(20),
      },
      {
        event: 'review_requested',
        actor: { login: 'alice' },
        requested_reviewer: { login: 'bob' },
        created_at: minutesAgo(5),
      },
    ];
    const result = computeAttentionSet(timeline, 'bob', 'alice', 10, NOW);
    expect(result.incomingDetail).toBe('rereview');
  });

  it('myRole = outgoing for PR author', () => {
    const timeline = [
      {
        event: 'review_requested',
        actor: { login: 'alice' },
        requested_reviewer: { login: 'bob' },
        created_at: minutesAgo(5),
      },
    ];
    const result = computeAttentionSet(timeline, 'alice', 'alice', 10, NOW);
    expect(result.myRole).toBe('outgoing');
  });

  it('myRole = mentioned for mentioned user', () => {
    const timeline = [
      {
        event: 'review_requested',
        actor: { login: 'alice' },
        requested_reviewer: { login: 'bob' },
        created_at: minutesAgo(10),
      },
      {
        event: 'commented',
        actor: { login: 'alice' },
        body: 'cc @carol please look',
        created_at: minutesAgo(5),
      },
    ];
    const result = computeAttentionSet(timeline, 'carol', 'alice', 10, NOW);
    expect(result.myRole).toBe('mentioned');
  });

  it('myRole = other for unrelated user', () => {
    const timeline = [
      {
        event: 'review_requested',
        actor: { login: 'alice' },
        requested_reviewer: { login: 'bob' },
        created_at: minutesAgo(5),
      },
    ];
    const result = computeAttentionSet(timeline, 'dave', 'alice', 10, NOW);
    expect(result.myRole).toBe('other');
  });
});

describe('never-empty attention set', () => {
  it('gives the author the turn when nobody else has it', () => {
    const result = computeAttentionSet([], 'alice', 'alice', 10);
    expect(result.set).toEqual({ alice: 'red' });
    expect(result.myStatus).toBe('red');
  });

  it('leaves drafts and PRs set to auto-merge empty', () => {
    const draft = computeAttentionSet([{ event: 'convert_to_draft', actor: { login: 'alice' }, created_at: '2026-05-01T09:00:00Z' }], 'alice', 'alice', 10);
    expect(draft.set).toEqual({});
    const merging = computeAttentionSet(
      [
        { event: 'auto_merge_enabled', actor: { login: 'alice' }, created_at: '2026-05-01T09:00:00Z' },
        { event: 'reviewed', actor: { login: 'bob', type: 'User' }, state: 'approved', submitted_at: '2026-05-01T10:00:00Z' },
      ],
      'alice',
      'alice',
      10,
      new Date('2026-05-01T11:00:00Z').getTime(),
    );
    expect(merging.set).toEqual({});
  });

  it('skips bot authors', () => {
    expect(computeAttentionSet([], 'me', 'dependabot[bot]', 10).set).toEqual({});
  });
});
