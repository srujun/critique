// A stand-in for api.github.com that answers the requests Critique makes from the made-up PRs in
// fixtures.js. Installed as the global fetch by demo/server.js, so the real server code runs unchanged.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ME, scenario, sha } from './fixtures.js';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const notFound = () => json({ message: 'Not Found' }, 404);

/** GitHub-style patch (hunks only, no file headers) between two versions of a file. */
function unifiedPatch(before, after) {
  const dir = mkdtempSync(join(tmpdir(), 'critique-demo-'));
  try {
    writeFileSync(join(dir, 'a'), before ?? '');
    writeFileSync(join(dir, 'b'), after ?? '');
    let out = '';
    try {
      execFileSync('diff', ['-U3', join(dir, 'a'), join(dir, 'b')]);
    } catch (e) {
      out = e.stdout.toString(); // diff exits 1 when the files differ
    }
    return out.split('\n').slice(2).join('\n').trimEnd();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function createFakeGitHub(now = Date.now()) {
  const prs = scenario(now);
  const byKey = new Map(prs.map((pr) => [`${pr.repo}#${pr.number}`, pr]));
  const url = (pr) => `https://github.com/${pr.repo}/pull/${pr.number}`;

  // Every version with file contents, oldest first per PR, so compare knows which way is ahead.
  const versions = new Map(); // sha -> { pr, index, files }
  for (const pr of prs) {
    versions.set(pr.base.sha, { pr, index: 0, files: pr.base.files });
    pr.commits.forEach((c, i) => versions.set(c.sha, { pr, index: i + 1, files: c.files }));
  }

  function compare(baseSha, headSha) {
    const a = versions.get(baseSha);
    const b = versions.get(headSha);
    if (!a || !b) {
      // A PR without file contents: report a small change so the dashboard has numbers to show.
      const files = ['src/index.ts', 'src/index.test.ts'].map((filename) => ({ filename, status: 'modified', additions: 4, deletions: 1, sha: sha(filename), patch: '' }));
      return { status: 'ahead', ahead_by: 1, merge_base_commit: { sha: baseSha }, files };
    }
    const files = [];
    for (const path of new Set([...Object.keys(a.files), ...Object.keys(b.files)])) {
      const before = a.files[path];
      const after = b.files[path];
      if (before === after) continue;
      const patch = unifiedPatch(before, after);
      const lines = patch.split('\n');
      files.push({
        filename: path,
        status: before === undefined ? 'added' : after === undefined ? 'removed' : 'modified',
        additions: lines.filter((l) => l.startsWith('+')).length,
        deletions: lines.filter((l) => l.startsWith('-')).length,
        sha: after === undefined ? null : sha(after),
        patch,
      });
    }
    const ahead = b.index >= a.index;
    return {
      status: ahead ? 'ahead' : 'behind',
      ahead_by: ahead ? b.index - a.index : 0,
      merge_base_commit: { sha: ahead ? baseSha : headSha },
      files,
    };
  }

  const threadNodes = (pr) =>
    pr.threads.map((t, i) => ({
      id: `${pr.repo}#${pr.number}-thread-${i}`,
      isResolved: t.isResolved,
      isOutdated: false,
      path: t.path,
      line: t.line,
      startLine: null,
      originalLine: t.anchorLine ?? t.line,
      originalStartLine: null,
      diffSide: 'RIGHT',
      comments: {
        nodes: t.comments.map((c, j) => ({
          author: { login: c.author },
          bodyHTML: `<p>${c.body}</p>`,
          createdAt: c.at,
          url: '#',
          diffHunk: j === 0 && t.anchorText ? anchorHunk(t.anchorText, t.anchorLine) : null,
          originalCommit: { oid: t.originalCommit || pr.head },
          pullRequestReview: { id: `review-${t.comments[0].author}` },
        })),
      },
    }));

  function graphql({ query, variables }) {
    if (query.includes('timelineItems')) {
      const pr = byKey.get(`${variables.owner}/${variables.name}#${variables.number}`);
      const c = pr?.conversation || { createdAt: null, bodyHTML: '', items: [] };
      return {
        repository: {
          pullRequest: pr && {
            author: { login: pr.author },
            createdAt: c.createdAt,
            bodyHTML: c.bodyHTML,
            timelineItems: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: c.items },
          },
        },
      };
    }
    if (query.includes('diffHunk')) {
      const pr = byKey.get(`${variables.owner}/${variables.name}#${variables.number}`);
      return { repository: { pullRequest: { reviewThreads: { nodes: pr ? threadNodes(pr) : [] } } } };
    }
    // Thread counts for the dashboard: one alias per PR.
    const data = {};
    for (const [, i, owner, name, number] of query.matchAll(/pr(\d+): repository\(owner: "([^"]+)", name: "([^"]+)"\) \{\s*pullRequest\(number: (\d+)\)/g)) {
      const pr = byKey.get(`${owner}/${name}#${number}`);
      data[`pr${i}`] = { pullRequest: { reviewThreads: { nodes: pr ? threadNodes(pr) : [] } } };
    }
    return data;
  }

  function rest(path, search) {
    if (path === '/user') return json({ login: ME });
    if (path === '/search/issues') {
      return json({
        items: prs.map((pr, i) => ({
          id: i + 1,
          number: pr.number,
          title: pr.title,
          html_url: url(pr),
          repository_url: `https://api.github.com/repos/${pr.repo}`,
          user: { login: pr.author },
        })),
      });
    }

    let m = path.match(/^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/timeline$/);
    if (m) {
      const pr = byKey.get(`${m[1]}#${m[2]}`);
      return pr ? json(search.get('page') === '1' ? pr.timeline : []) : notFound();
    }
    m = path.match(/^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/);
    if (m) {
      const pr = byKey.get(`${m[1]}#${m[2]}`);
      if (!pr) return notFound();
      return json({
        html_url: url(pr),
        title: pr.title,
        user: { login: pr.author },
        state: 'open',
        draft: pr.draft || false,
        merged_at: null,
        head: { sha: pr.head, ref: 'feature' },
        base: { sha: pr.base.sha, ref: 'main' },
      });
    }
    m = path.match(/^\/repos\/[^/]+\/[^/]+\/compare\/([0-9a-f]+)\.\.\.([0-9a-f]+)$/);
    if (m) return json(compare(m[1], m[2]));
    m = path.match(/^\/repos\/[^/]+\/[^/]+\/git\/trees\/([0-9a-f]+)$/);
    if (m) {
      const files = versions.get(m[1])?.files || {};
      return json({ truncated: false, tree: Object.keys(files).map((p) => ({ type: 'blob', path: p })) });
    }
    m = path.match(/^\/repos\/[^/]+\/[^/]+\/contents\/(.+)$/);
    if (m) {
      const text = versions.get(search.get('ref'))?.files[decodeURIComponent(m[1])];
      return text === undefined ? notFound() : new Response(text, { headers: { 'Content-Type': 'text/plain' } });
    }
    return notFound();
  }

  return async function fakeFetch(input, init = {}) {
    const target = new URL(typeof input === 'string' ? input : input.url);
    if (target.hostname !== 'api.github.com') throw new Error(`demo: unexpected request to ${target.hostname}`);
    if (target.pathname === '/graphql') return json({ data: graphql(JSON.parse(init.body)) });
    return rest(target.pathname, target.searchParams);
  };
}

/** The last few lines up to `line`, as the diff hunk GitHub stores with a comment. */
function anchorHunk(text, line) {
  const lines = text.split('\n').slice(Math.max(0, line - 4), line);
  return `@@ -0,0 +${line - lines.length + 1},${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}`;
}
