// A PR's conversation for the review page: its description plus the timeline GitHub shows on the
// Conversation tab (comments, reviews, pushes, review requests, and status changes).

import { ghGraphql } from './github.js';

const MAX_PAGES = 5; // 100 timeline items each

const actor = `actor { login }`;
const QUERY = `
query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      author { login }
      createdAt
      bodyHTML
      timelineItems(first: 100, after: $after, itemTypes: [
        ISSUE_COMMENT, PULL_REQUEST_REVIEW, PULL_REQUEST_COMMIT, HEAD_REF_FORCE_PUSHED_EVENT,
        REVIEW_REQUESTED_EVENT, REVIEW_REQUEST_REMOVED_EVENT, REVIEW_DISMISSED_EVENT,
        READY_FOR_REVIEW_EVENT, CONVERT_TO_DRAFT_EVENT, LABELED_EVENT, UNLABELED_EVENT,
        RENAMED_TITLE_EVENT, MERGED_EVENT, CLOSED_EVENT, REOPENED_EVENT
      ]) {
        pageInfo { hasNextPage endCursor }
        nodes {
          __typename
          ... on IssueComment { author { login } createdAt bodyHTML url }
          ... on PullRequestReview { id author { login } state submittedAt createdAt bodyHTML url commit { oid } comments { totalCount } }
          ... on PullRequestCommit { commit { oid messageHeadline committedDate author { user { login } name } } }
          ... on HeadRefForcePushedEvent { ${actor} createdAt beforeCommit { oid } afterCommit { oid } }
          ... on ReviewRequestedEvent { ${actor} createdAt requestedReviewer { ... on User { login } ... on Team { name } ... on Bot { login } ... on Mannequin { login } } }
          ... on ReviewRequestRemovedEvent { ${actor} createdAt requestedReviewer { ... on User { login } ... on Team { name } ... on Bot { login } ... on Mannequin { login } } }
          ... on ReviewDismissedEvent { ${actor} createdAt }
          ... on ReadyForReviewEvent { ${actor} createdAt }
          ... on ConvertToDraftEvent { ${actor} createdAt }
          ... on LabeledEvent { ${actor} createdAt label { name } }
          ... on UnlabeledEvent { ${actor} createdAt label { name } }
          ... on RenamedTitleEvent { ${actor} createdAt previousTitle currentTitle }
          ... on MergedEvent { ${actor} createdAt }
          ... on ClosedEvent { ${actor} createdAt }
          ... on ReopenedEvent { ${actor} createdAt }
        }
      }
    }
  }
}`;

const who = (n) => n?.author?.login || n?.actor?.login || 'ghost';
const reviewer = (r) => r?.login || r?.name || 'someone';

/** One timeline node in a flat shape the page can render without knowing GraphQL type names. */
export function normalizeItem(n) {
  switch (n.__typename) {
    case 'IssueComment':
      return { kind: 'comment', author: who(n), at: n.createdAt, bodyHTML: n.bodyHTML, url: n.url };
    case 'PullRequestReview':
      // Reviews still pending (unsubmitted drafts) only show for their author; skip them.
      if (n.state === 'PENDING') return null;
      return {
        kind: 'review',
        id: n.id,
        author: who(n),
        at: n.submittedAt || n.createdAt,
        state: n.state.toLowerCase(), // approved | changes_requested | commented | dismissed
        bodyHTML: n.bodyHTML,
        url: n.url,
        commit: n.commit?.oid || null,
        inlineComments: n.comments?.totalCount || 0,
      };
    case 'PullRequestCommit': {
      const c = n.commit;
      return { kind: 'commit', author: c.author?.user?.login || c.author?.name || 'someone', at: c.committedDate, sha: c.oid, message: c.messageHeadline };
    }
    case 'HeadRefForcePushedEvent':
      return { kind: 'force-push', author: who(n), at: n.createdAt, before: n.beforeCommit?.oid || null, after: n.afterCommit?.oid || null };
    case 'ReviewRequestedEvent':
      return { kind: 'event', author: who(n), at: n.createdAt, text: `requested a review from ${reviewer(n.requestedReviewer)}` };
    case 'ReviewRequestRemovedEvent':
      return { kind: 'event', author: who(n), at: n.createdAt, text: `removed the review request for ${reviewer(n.requestedReviewer)}` };
    case 'ReviewDismissedEvent':
      return { kind: 'event', author: who(n), at: n.createdAt, text: 'dismissed a review' };
    case 'ReadyForReviewEvent':
      return { kind: 'event', author: who(n), at: n.createdAt, text: 'marked this ready for review' };
    case 'ConvertToDraftEvent':
      return { kind: 'event', author: who(n), at: n.createdAt, text: 'converted this to a draft' };
    case 'LabeledEvent':
      return { kind: 'event', author: who(n), at: n.createdAt, text: `added the label ${n.label?.name}` };
    case 'UnlabeledEvent':
      return { kind: 'event', author: who(n), at: n.createdAt, text: `removed the label ${n.label?.name}` };
    case 'RenamedTitleEvent':
      return { kind: 'event', author: who(n), at: n.createdAt, text: `changed the title from “${n.previousTitle}” to “${n.currentTitle}”` };
    case 'MergedEvent':
      return { kind: 'event', author: who(n), at: n.createdAt, text: 'merged this' };
    case 'ClosedEvent':
      return { kind: 'event', author: who(n), at: n.createdAt, text: 'closed this' };
    case 'ReopenedEvent':
      return { kind: 'event', author: who(n), at: n.createdAt, text: 'reopened this' };
    default:
      return null;
  }
}

export async function fetchConversation(repo, number, token, opts) {
  const [owner, name] = repo.split('/');
  const items = [];
  let pr = null;
  let after = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await ghGraphql(QUERY, { owner, name, number: Number(number), after }, token, opts);
    pr = data?.repository?.pullRequest;
    if (!pr) break;
    for (const n of pr.timelineItems.nodes) {
      const item = normalizeItem(n);
      if (item) items.push(item);
    }
    if (!pr.timelineItems.pageInfo.hasNextPage) break;
    after = pr.timelineItems.pageInfo.endCursor;
  }
  return {
    author: pr?.author?.login || 'ghost',
    createdAt: pr?.createdAt || null,
    bodyHTML: pr?.bodyHTML || '',
    items,
    truncated: !!pr?.timelineItems.pageInfo.hasNextPage,
  };
}
