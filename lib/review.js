// Data for the review page: a PR's version history and the diff between any two of its versions.
//
// Everything here is keyed by commit SHA, which never changes, so results are cached in memory
// for the life of the server.

import { classify, parseGitattributes } from './classify.js';
import { ghFetch, ghFileContents } from './github.js';

const MAX_SNAPSHOT_FILES = 150; // each costs two content fetches
const CONTENT_CONCURRENCY = 8;
const MAX_CACHED_FILE_BYTES = 2 * 1024 * 1024;
const ATTRIBUTES_PATHS_TTL = 60 * 60 * 1000;

class LruCache {
  constructor(max) {
    this.max = max;
    this.map = new Map();
  }
  has(key) {
    return this.map.has(key);
  }
  get(key) {
    const value = this.map.get(key);
    if (value !== undefined) {
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }
  set(key, value) {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }
}

const compareCache = new LruCache(200);
const contentCache = new LruCache(2000);
const attributesPathsCache = new Map(); // repo -> { paths, at }

/** GitHub's three-dot compare: changes on `head` since its merge base with `base`. */
async function compare(repo, base, head, token, opts) {
  const key = `${repo}:${base}...${head}`;
  if (!compareCache.has(key)) {
    // per_page=1 trims the commit list; the file list always covers the whole comparison.
    compareCache.set(key, await ghFetch(`/repos/${repo}/compare/${base}...${head}?per_page=1`, token, opts));
  }
  return compareCache.get(key);
}

export async function fileContents(repo, ref, path, token, opts) {
  const key = `${repo}:${ref}:${path}`;
  if (contentCache.has(key)) return contentCache.get(key);
  const text = await ghFileContents(repo, ref, path, token, opts);
  if (text === null || text.length <= MAX_CACHED_FILE_BYTES) contentCache.set(key, text);
  return text;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

const patchFile = (f, oldRef, newRef) => ({
  name: f.filename,
  prevName: f.previous_filename || null,
  status: f.status,
  additions: f.additions,
  deletions: f.deletions,
  blobSha: f.sha,
  patch: f.patch ?? null, // missing for binary files and very large diffs
  oldRef,
  newRef,
});

/**
 * Where a repo keeps .gitattributes files. Listing the whole tree is a few MB on a large monorepo, so
 * the list is reused for an hour per repo; the files themselves are always read at the commit shown.
 */
async function gitattributesPaths(repo, ref, token, opts) {
  const cached = attributesPathsCache.get(repo);
  if (cached && Date.now() - cached.at < ATTRIBUTES_PATHS_TTL) return cached.paths;
  let paths = ['.gitattributes'];
  try {
    const tree = await ghFetch(`/repos/${repo}/git/trees/${ref}?recursive=1`, token, opts);
    if (!tree.truncated) {
      paths = tree.tree
        .filter((e) => e.type === 'blob' && (e.path === '.gitattributes' || e.path.endsWith('/.gitattributes')))
        .map((e) => e.path);
    }
  } catch {
    // fall back to the root file only
  }
  attributesPathsCache.set(repo, { paths, at: Date.now() });
  return paths;
}

/** linguist-generated rules at a commit, ordered root first so deeper files win. */
async function attributeRules(repo, ref, token, opts) {
  const depth = (p) => p.split('/').length;
  const paths = [...(await gitattributesPaths(repo, ref, token, opts))].sort((a, b) => depth(a) - depth(b));
  const texts = await mapLimit(paths, CONTENT_CONCURRENCY, (p) => fileContents(repo, ref, p, token, opts));
  return paths.flatMap((p, i) => (texts[i] ? parseGitattributes(texts[i], p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '') : []));
}

/** The diff between two versions, with each file tagged as source, test, or generated. */
export async function buildDiff(repo, pr, base, head, token, opts) {
  head ||= pr.head.sha;
  const [diff, rules] = await Promise.all([
    diffBetween(repo, pr, base, head, token, opts),
    attributeRules(repo, head, token, opts).catch(() => []),
  ]);
  for (const file of diff.files) file.section = classify(file.name, rules);
  return diff;
}

/**
 * The diff to show between two versions of a PR.
 *
 * - No `base`: the whole PR, i.e. GitHub's "Files changed" (merge base → head).
 * - `base` is an ancestor of `head`: a plain diff between them. Patches come from GitHub; the page
 *   loads full files on demand to expand context.
 * - Otherwise the branch was rebased in between, and a plain diff would include everything that
 *   landed on the base branch. Instead, compare each file the PR touches (in either version) as it
 *   was at `base` and at `head`.
 */
async function diffBetween(repo, pr, base, head, token, opts) {
  if (!base) {
    const cmp = await compare(repo, pr.base.sha, head, token, opts);
    const mergeBase = cmp.merge_base_commit.sha;
    return {
      mode: 'patch',
      base: mergeBase,
      head,
      files: cmp.files.map((f) => patchFile(f, mergeBase, head)),
      truncated: cmp.files.length >= 300,
    };
  }

  const direct = await compare(repo, base, head, token, opts);
  if (direct.status === 'ahead' || direct.status === 'identical') {
    return {
      mode: 'patch',
      base,
      head,
      files: direct.files.map((f) => patchFile(f, base, head)),
      truncated: direct.files.length >= 300,
    };
  }

  const [before, after] = await Promise.all([
    compare(repo, pr.base.sha, base, token, opts),
    compare(repo, pr.base.sha, head, token, opts),
  ]);
  const touched = new Map();
  for (const f of before.files) touched.set(f.filename, { name: f.filename, prevName: f.previous_filename || null });
  for (const f of after.files) {
    touched.set(f.filename, { name: f.filename, prevName: f.previous_filename || null, blobSha: f.sha });
  }
  const candidates = [...touched.values()].slice(0, MAX_SNAPSHOT_FILES);

  const files = await mapLimit(candidates, CONTENT_CONCURRENCY, async (f) => {
    let oldContents = await fileContents(repo, base, f.name, token, opts);
    let oldName = f.name;
    if (oldContents === null && f.prevName) {
      oldContents = await fileContents(repo, base, f.prevName, token, opts);
      oldName = f.prevName;
    }
    const newContents = await fileContents(repo, head, f.name, token, opts);
    if (oldContents === newContents) return null;
    const status = oldContents === null ? 'added' : newContents === null ? 'removed' : oldName !== f.name ? 'renamed' : 'modified';
    return {
      name: f.name,
      prevName: oldName !== f.name ? oldName : null,
      status,
      blobSha: f.blobSha || null,
      oldContents,
      newContents,
      oldRef: base,
      newRef: head,
    };
  });

  return {
    mode: 'snapshot',
    base,
    head,
    files: files.filter(Boolean),
    truncated: touched.size > MAX_SNAPSHOT_FILES,
  };
}

const firstLine = (s) => (s || '').split('\n')[0];
const REVIEW_VERBS = { approved: 'approved', changes_requested: 'requested changes', commented: 'commented' };

/**
 * Every version of the PR worth comparing, oldest first: each commit, each head Critique saw
 * while polling (which catches force-pushes), and each commit someone reviewed.
 */
export function buildRevisions(timeline, headHistory, headSha, me) {
  const bySha = new Map();
  // A review happens after its commit was made, so its time is only a fallback for ordering.
  const add = (sha, at, label, { fromReview = false } = {}) => {
    if (!sha) return null;
    const rev = bySha.get(sha) || { sha, commitAt: 0, reviewAt: 0, labels: [], reviewedByMe: false };
    const key = fromReview ? 'reviewAt' : 'commitAt';
    if (at && (!rev[key] || at < rev[key])) rev[key] = at;
    if (label && !rev.labels.includes(label)) rev.labels.push(label);
    bySha.set(sha, rev);
    return rev;
  };

  for (const ev of timeline) {
    const type = ev.event || ev.__type;
    if (type === 'committed') {
      add(ev.sha, new Date(ev.committer?.date || 0).getTime(), firstLine(ev.message));
    } else if (type === 'head_ref_force_pushed' && ev.commit_id) {
      add(ev.commit_id, new Date(ev.created_at || 0).getTime(), `force-pushed by ${ev.actor?.login || 'someone'}`);
    } else if (type === 'reviewed' && ev.commit_id) {
      const who = ev.user?.login || ev.actor?.login || 'someone';
      const label = `${who === me ? 'you' : who} ${REVIEW_VERBS[ev.state] || 'reviewed'}`;
      const rev = add(ev.commit_id, new Date(ev.submitted_at || 0).getTime(), label, { fromReview: true });
      if (who === me) rev.reviewedByMe = true;
    }
  }
  for (const h of headHistory || []) add(h.sha, h.since, null);
  add(headSha, 0, null);

  return [...bySha.values()]
    .map(({ sha, commitAt, reviewAt, labels, reviewedByMe }) => ({
      sha,
      at: commitAt || reviewAt || 0,
      labels,
      reviewedByMe,
      isHead: sha === headSha,
    }))
    .sort((a, b) => (a.isHead ? 1 : 0) - (b.isHead ? 1 : 0) || (a.at || Infinity) - (b.at || Infinity));
}

/** The commit your most recent review was made on. */
export function myLastReviewCommit(timeline, me) {
  let sha = null;
  for (const ev of timeline) {
    if ((ev.event || ev.__type) === 'reviewed' && (ev.user?.login || ev.actor?.login) === me && ev.commit_id) {
      sha = ev.commit_id;
    }
  }
  return sha;
}
