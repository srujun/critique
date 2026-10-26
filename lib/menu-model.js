// What the desktop app's menu bar menu shows, as plain data: desktop/main.js turns it into a native
// macOS menu. Kept free of Electron so it can be tested.

export const MAX_NEEDS = 12;
export const MAX_WAITING = 15;
const MAX_TITLE = 60;

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const names = (list) => (list.length <= 2 ? list.join(' and ') : `${list.slice(0, 2).join(', ')} and ${list.length - 2} more`);
const truncate = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const needsMe = (pr) => pr.myStatus === 'red' || pr.myStatus === 'yellow';

/** One line saying why a PR is in the list and what's expected of you. */
export function reasonFor(pr, me) {
  if (pr.steppedOutAt) return 'Not your turn until someone responds';
  if (!needsMe(pr)) {
    const others = Object.keys(pr.attentionSet || {}).filter((u) => u !== me);
    return others.length ? `Waiting on ${names(others)}` : 'Nobody needs to act';
  }
  if (pr.myRole === 'incoming') {
    if (pr.incomingDetail === 'rereview') return 'Re-review requested';
    if (pr.incomingDetail === 'updated') {
      const s = pr.sinceReview;
      if (s?.rebased) return 'Rebased since your review';
      if (s?.newCommits) return `${plural(s.newCommits, 'new commit')} since your review`;
      return 'Author replied since your review';
    }
    return 'Review requested';
  }
  if (pr.myRole === 'outgoing') {
    const requesting = Object.entries(pr.reviewerStates || {})
      .filter(([, state]) => state === 'changes_requested')
      .map(([user]) => user);
    if (pr.prState === 'CHANGES_REQUESTED') return requesting.length ? `Changes requested by ${names(requesting)}` : 'Changes requested';
    if (pr.prState === 'COMMENTED') return 'New review comments';
    if (pr.prState === 'APPROVED_NO_AUTOMERGE') return 'Approved, ready to merge';
    if (pr.prState === 'STALLED_MERGE') return 'Auto-merge is stuck';
  }
  if (pr.myRole === 'mentioned') return 'You were mentioned';
  return 'Your move';
}

/** "Not my turn" only makes sense when someone else would hold the turn: another person, or the author. */
export const canStepOut = (pr, me) =>
  needsMe(pr) && (pr.author !== me || Object.keys(pr.attentionSet || {}).some((u) => u !== me));

const reviewQuery = (pr, extra = {}) => new URLSearchParams({ repo: pr.repo, number: pr.number, ...extra }).toString();

/** A PR's menu item: title, a subtitle with the reason, a status dot, and its submenu of actions. */
export function prEntry(pr, view) {
  const seen = (view.dismissedClicked?.[pr.url] || 0) > (pr.lastEventAt || 0);
  const waitingThreads = pr.threads?.waitingOnMe || 0;
  const since = pr.sinceReview;
  const repoName = pr.repo.split('/')[1];
  const sublabel = [reasonFor(pr, view.username), waitingThreads && `${plural(waitingThreads, 'thread')} waiting on you`, `${repoName}#${pr.number}`]
    .filter(Boolean)
    .join(' · ');

  const sinceLabel = since?.rebased
    ? 'Review Changes Since Your Review (rebased)'
    : since?.newCommits
      ? `Review Changes Since Your Review (${plural(since.newCommits, 'commit')})`
      : 'Review Changes Since Your Review';

  return {
    label: truncate(pr.title, MAX_TITLE),
    sublabel,
    dot: `${pr.myStatus}${seen ? '-seen' : ''}`,
    actions: [
      { label: 'Review in Critique', action: { kind: 'review', query: reviewQuery(pr), url: pr.url } },
      since?.base && { label: sinceLabel, action: { kind: 'review', query: reviewQuery(pr, { base: since.base }), url: pr.url } },
      { label: 'Open on GitHub', action: { kind: 'external', url: pr.url } },
      { separator: true },
      canStepOut(pr, view.username) && { label: 'Not My Turn Until Someone Responds', action: { kind: 'post', path: '/api/attention', body: { url: pr.url, mine: false } } },
      pr.steppedOutAt && { label: 'Back to My Turn', action: { kind: 'post', path: '/api/attention', body: { url: pr.url, mine: true } } },
      { label: 'Copy Link', action: { kind: 'copy', text: pr.url } },
      { label: 'Dismiss', action: { kind: 'post', path: '/api/dismiss', body: { url: pr.url, lastEventAt: pr.lastEventAt } } },
      { label: `Mute ${pr.repo}`, action: { kind: 'post', path: '/api/mute', body: { repo: pr.repo } } },
    ].filter(Boolean),
  };
}

function relative(ms, now) {
  if (!ms) return null;
  const m = Math.round((now - ms) / 60_000);
  if (m < 1) return 'Updated just now';
  if (m < 60) return `Updated ${m}m ago`;
  return `Updated ${Math.round(m / 60)}h ago`;
}

/**
 * @param {object} view  the dashboard view from /api/events
 * @returns {{ count: number, title: string, tooltip: string, error: string|null, updated: string|null, polling: boolean,
 *             needs: object[], needsMore: number, waiting: object[], waitingMore: number }}
 */
export function menuModel(view, now = Date.now()) {
  const byRecent = (a, b) => (b.lastEventAt || 0) - (a.lastEventAt || 0);
  const visible = view.results.filter((pr) => !view.dismissed?.[pr.url]);
  const needs = visible.filter(needsMe).sort(byRecent);
  const waiting = visible.filter((pr) => !needsMe(pr)).sort(byRecent);
  const count = view.needsAttention;

  let error = null;
  if (view.lastError?.type === 'auth') error = 'GitHub token missing or rejected';
  else if (view.lastError) error = 'Last refresh failed';

  return {
    count,
    title: error ? '!' : count > 0 ? String(count) : '',
    tooltip: error ? `Critique: ${error}` : count > 0 ? `Critique: ${plural(count, 'PR')} need you` : "Critique: you're all caught up",
    error,
    updated: relative(view.lastPoll, now),
    polling: !!view.polling,
    needs: needs.slice(0, MAX_NEEDS).map((pr) => prEntry(pr, view)),
    needsMore: Math.max(0, needs.length - MAX_NEEDS),
    waiting: waiting.slice(0, MAX_WAITING).map((pr) => prEntry(pr, view)),
    waitingMore: Math.max(0, waiting.length - MAX_WAITING),
  };
}
