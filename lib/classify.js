// Sorts a PR's files into source, test, and generated sections for the review page.
//
// "Generated" follows the repo's linguist-generated rules in .gitattributes (what GitHub uses to
// collapse generated files), falling back to common generated-file patterns where no rule applies.
// A rule of linguist-generated=false always wins, so a repo can exempt files like migrations.

// --- .gitattributes ---

/** Convert a gitattributes glob to a RegExp over slash-separated paths (gitignore pattern rules). */
export function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const atStart = i === 0 || glob[i - 1] === '/';
        if (atStart && glob[i + 2] === '/') {
          re += '(?:.*/)?'; // "**/" matches zero or more directories
          i += 2;
          continue;
        }
        if (atStart && i + 2 === glob.length) {
          re += '.*'; // trailing "/**" matches everything inside
          i += 1;
          continue;
        }
      }
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end === -1) {
        re += '\\[';
      } else {
        re += `[${glob.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`;
        i = end;
      }
    } else {
      re += c.replace(/[.+^${}()|\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

/**
 * Parse the linguist-generated rules from one .gitattributes file.
 * @param {string} text
 * @param {string} dir  the directory holding the file ('' for the repo root)
 * @returns {{ dir: string, regex: RegExp, basenameOnly: boolean, value: boolean | null }[]}
 *   value: true/false when the rule sets or unsets the attribute, null when it resets it ("!attr")
 */
export function parseGitattributes(text, dir = '') {
  const rules = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [pattern, ...attrs] = line.split(/\s+/);
    let value;
    for (const attr of attrs) {
      if (attr === 'linguist-generated' || attr === 'linguist-generated=true') value = true;
      else if (attr === '-linguist-generated' || attr === 'linguist-generated=false') value = false;
      else if (attr === '!linguist-generated') value = null;
    }
    if (value === undefined) continue;
    const anchored = pattern.startsWith('/');
    const glob = anchored ? pattern.slice(1) : pattern;
    // A pattern without a slash matches the file name at any depth below the attributes file.
    rules.push({ dir, regex: globToRegex(glob), basenameOnly: !anchored && !glob.includes('/'), value });
  }
  return rules;
}

/**
 * The linguist-generated value for a path: true, false, or undefined when no rule applies.
 * `rules` must be ordered from the root .gitattributes down to the deepest; later rules win.
 */
export function attributeFor(path, rules) {
  let value;
  for (const rule of rules) {
    if (rule.dir && !path.startsWith(`${rule.dir}/`)) continue;
    const relative = rule.dir ? path.slice(rule.dir.length + 1) : path;
    const subject = rule.basenameOnly ? relative.slice(relative.lastIndexOf('/') + 1) : relative;
    if (rule.regex.test(subject)) value = rule.value === null ? undefined : rule.value;
  }
  return value;
}

// --- Fallback patterns ---

const GENERATED_FALLBACK = [
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|go\.sum|poetry\.lock|uv\.lock|Pipfile\.lock|Gemfile\.lock|composer\.lock|flake\.lock)$/,
  /\.min\.(js|css)$/,
  /\.(pb\.go|pb\.ts|_pb2\.py|_pb2_grpc\.py|g\.dart|designer\.cs)$/,
  /(^|\/)(__generated__|generated)\//,
];

// Test files, test directories, and test helpers (fixtures, mocks, snapshots).
const TEST_PATTERNS = [
  /\.(test|spec)\.[^/]+$/,
  /_test\.(go|py|rb|exs?)$/,
  /_spec\.rb$/,
  /(^|\/)test_[^/]+\.py$/,
  /(^|\/)[^/]*Tests?\.(java|kt|cs|swift|scala)$/,
  /\.snap$/,
  /(^|\/)(__tests__|__mocks__|__snapshots__|__fixtures__|tests?|e2e|specs?|fixtures|testdata|test-utils|test-helpers|mocks)\//,
];

export const isTestPath = (path) => TEST_PATTERNS.some((re) => re.test(path));

/**
 * @param {string} path
 * @param {ReturnType<typeof parseGitattributes>} rules
 * @returns {'source' | 'test' | 'generated'}  generated wins over test
 */
export function classify(path, rules) {
  const attr = attributeFor(path, rules);
  const generated = attr ?? GENERATED_FALLBACK.some((re) => re.test(path));
  if (generated) return 'generated';
  return isTestPath(path) ? 'test' : 'source';
}
