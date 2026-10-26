// Minimal GitHub REST client with ETag caching.
// Conditional requests that come back 304 don't count against the rate limit.

export class GitHubError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// `used`, when given, collects every URL fetched so callers can prune the ETag cache to what's still live.
export async function ghFetch(path, token, { fetcher = fetch, etagCache = null, used = null } = {}) {
  const url = `https://api.github.com${path}`;
  used?.add(url);
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  const cached = etagCache?.get(url);
  if (cached?.etag) headers['If-None-Match'] = cached.etag;

  const res = await fetcher(url, { headers });
  if (res.status === 304 && cached?.data) return cached.data;
  if (!res.ok) throw new GitHubError(res.status, `GitHub API ${res.status} for ${path}`);

  const data = await res.json();
  const etag = res.headers?.get?.('etag');
  if (etagCache && etag) etagCache.set(url, { etag, data });
  return data;
}

const baseHeaders = (token) => ({ Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' });

/** Raw file contents at a ref, or null if the file doesn't exist there. Needs "Contents: read". */
export async function ghFileContents(repo, ref, path, token, { fetcher = fetch } = {}) {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  const res = await fetcher(`https://api.github.com/repos/${repo}/contents/${encodedPath}?ref=${ref}`, {
    headers: { ...baseHeaders(token), Accept: 'application/vnd.github.raw+json' },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new GitHubError(res.status, `GitHub API ${res.status} for contents of ${path}@${ref}`);
  return res.text();
}

export async function ghGraphql(query, variables, token, { fetcher = fetch } = {}) {
  const res = await fetcher('https://api.github.com/graphql', {
    method: 'POST',
    headers: { ...baseHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new GitHubError(res.status, `GitHub GraphQL ${res.status}`);
  const body = await res.json();
  // Partial data is still useful (e.g. one aliased PR was deleted), so only throw when nothing came back.
  if (body.errors && !body.data) throw new GitHubError(502, `GitHub GraphQL: ${body.errors[0]?.message}`);
  return body.data;
}
