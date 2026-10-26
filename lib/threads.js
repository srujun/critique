// Review comment threads from GitHub's GraphQL API (REST has no thread resolution state).

import { isBot } from './attention.js';
import { ghGraphql } from './github.js';

/**
 * A thread is waiting on you when it's unresolved, someone else spoke last, and it's yours to answer:
 * you're in the conversation, or it's on your PR.
 */
export function isWaitingOn(me, prAuthor, thread) {
  if (thread.isResolved) return false;
  const authors = thread.comments.map((c) => c.author).filter((a) => a && !isBot(a));
  if (authors.length === 0) return false;
  const last = authors[authors.length - 1];
  if (last === me) return false;
  return authors.includes(me) || prAuthor === me;
}

const splitRepo = (repo) => {
  const [owner, name] = repo.split('/');
  return { owner, name };
};

const THREADS_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        nodes {
          id isResolved isOutdated path line startLine originalLine originalStartLine diffSide
          comments(first: 50) {
            nodes { author { login } bodyHTML createdAt url diffHunk originalCommit { oid } pullRequestReview { id } }
          }
        }
      }
    }
  }
}`;

const ANCHOR_CONTEXT = 3;

/**
 * The code a comment was made on: the last few lines of its diff hunk on the commented side,
 * without the +/-/space prefix. The final entry is the commented line itself.
 */
export function anchorLines(diffHunk, side) {
  if (!diffHunk) return [];
  const otherSide = side === 'deletions' ? '+' : '-';
  return diffHunk
    .trimEnd()
    .split('\n')
    .filter((l) => !l.startsWith('@@') && !l.startsWith(otherSide))
    .slice(-ANCHOR_CONTEXT)
    .map((l) => l.slice(1));
}

/** Every review thread on a PR, with comment bodies, for the review page. */
export async function fetchThreads(repo, number, me, prAuthor, token, opts) {
  const data = await ghGraphql(THREADS_QUERY, { ...splitRepo(repo), number: Number(number) }, token, opts);
  const nodes = data?.repository?.pullRequest?.reviewThreads?.nodes || [];
  return nodes.map((t) => {
    const thread = {
      id: t.id,
      path: t.path,
      line: t.line,
      startLine: t.startLine,
      originalLine: t.originalLine,
      originalStartLine: t.originalStartLine,
      side: t.diffSide === 'LEFT' ? 'deletions' : 'additions',
      // Where the thread started, so outdated threads can be carried forward to the same code.
      originalCommit: t.comments.nodes[0]?.originalCommit?.oid || null,
      reviewId: t.comments.nodes[0]?.pullRequestReview?.id || null, // the review that started it
      anchor: anchorLines(t.comments.nodes[0]?.diffHunk, t.diffSide === 'LEFT' ? 'deletions' : 'additions'),
      isResolved: t.isResolved,
      isOutdated: t.isOutdated,
      comments: t.comments.nodes.map((c) => ({
        author: c.author?.login || 'ghost',
        bodyHTML: c.bodyHTML,
        createdAt: c.createdAt,
        url: c.url,
      })),
    };
    thread.waitingOnMe = isWaitingOn(me, prAuthor, thread);
    return thread;
  });
}

/**
 * Thread counts for many PRs in one aliased query, for the dashboard.
 * @param {{ repo: string, number: number, author: string, url: string }[]} prs
 * @returns {Promise<Record<string, { unresolved: number, waitingOnMe: number }>>} keyed by PR url
 */
export async function fetchThreadSummaries(prs, me, token, opts) {
  if (prs.length === 0) return {};
  const parts = prs.map((pr, i) => {
    const { owner, name } = splitRepo(pr.repo);
    return `pr${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {
      pullRequest(number: ${Number(pr.number)}) {
        reviewThreads(first: 50) { nodes { isResolved comments(first: 30) { nodes { author { login } } } } }
      }
    }`;
  });
  const data = await ghGraphql(`query { ${parts.join('\n')} }`, {}, token, opts);

  const out = {};
  prs.forEach((pr, i) => {
    const nodes = data?.[`pr${i}`]?.pullRequest?.reviewThreads?.nodes;
    if (!nodes) return;
    const threads = nodes.map((t) => ({
      isResolved: t.isResolved,
      comments: t.comments.nodes.map((c) => ({ author: c.author?.login })),
    }));
    out[pr.url] = {
      unresolved: threads.filter((t) => !t.isResolved).length,
      waitingOnMe: threads.filter((t) => isWaitingOn(me, pr.author, t)).length,
    };
  });
  return out;
}
