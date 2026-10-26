import { describe, it, expect } from 'vitest';
import { attributeFor, classify, globToRegex, parseGitattributes } from '../lib/classify.js';

// A typical monorepo's rules.
const SAMPLE = `
# Lock files
yarn.lock linguist-generated
flake.lock linguist-generated
packages/*/src/**/generated/** linguist-generated
**/.antlr/** linguist-generated
*.interp linguist-generated
packages/server/src/generated/migrations/**/*.sql linguist-generated=false
* text=auto eol=lf
`;

describe('globToRegex', () => {
  it('follows gitignore rules for *, ** and ?', () => {
    expect(globToRegex('*.ts').test('a.ts')).toBe(true);
    expect(globToRegex('*.ts').test('dir/a.ts')).toBe(false);
    expect(globToRegex('a/**/b').test('a/b')).toBe(true);
    expect(globToRegex('a/**/b').test('a/x/y/b')).toBe(true);
    expect(globToRegex('**/x').test('deep/er/x')).toBe(true);
    expect(globToRegex('dir/**').test('dir/any/thing.js')).toBe(true);
    expect(globToRegex('file?.js').test('file1.js')).toBe(true);
  });
});

describe('linguist-generated rules', () => {
  const rules = parseGitattributes(SAMPLE);

  it('ignores lines without the attribute', () => {
    expect(rules).toHaveLength(6);
  });

  it('matches name-only patterns at any depth', () => {
    expect(attributeFor('yarn.lock', rules)).toBe(true);
    expect(attributeFor('packages/x/grammar.interp', rules)).toBe(true);
  });

  it('matches path patterns from the root', () => {
    expect(attributeFor('packages/api/src/generated/resolvers.ts', rules)).toBe(true);
    expect(attributeFor('packages/api/src/deep/generated/x/y.ts', rules)).toBe(true);
    expect(attributeFor('packages/api/src/resolvers.ts', rules)).toBe(undefined);
  });

  it('lets a later =false rule exempt files', () => {
    expect(attributeFor('packages/server/src/generated/migrations/2026/up.sql', rules)).toBe(false);
    expect(attributeFor('packages/server/src/generated/migrations/2026/notes.ts', rules)).toBe(true);
  });

  it('scopes nested .gitattributes to their directory, and deeper files win', () => {
    const nested = [...parseGitattributes('*.json linguist-generated'), ...parseGitattributes('*.json -linguist-generated', 'keep')];
    expect(attributeFor('a/b.json', nested)).toBe(true);
    expect(attributeFor('keep/b.json', nested)).toBe(false);
  });
});

describe('classify', () => {
  const rules = parseGitattributes(SAMPLE);

  it('puts tests and their helpers in tests', () => {
    for (const p of ['src/a.test.ts', 'src/__tests__/a.ts', 'pkg/foo_test.go', 'tests/conftest.py', 'e2e/flow.ts', 'src/__fixtures__/x.json', 'x/__snapshots__/a.snap']) {
      expect(classify(p, []), p).toBe('test');
    }
  });

  it('uses .gitattributes first, then fallback patterns', () => {
    expect(classify('packages/api/src/generated/resolvers.ts', rules)).toBe('generated');
    expect(classify('package-lock.json', [])).toBe('generated');
    // An explicit =false beats the fallback "generated/" folder pattern.
    expect(classify('packages/server/src/generated/migrations/1/up.sql', rules)).toBe('source');
  });

  it('treats generated test code as generated', () => {
    expect(classify('packages/api/src/generated/a.test.ts', rules)).toBe('generated');
  });

  it('leaves everything else as source', () => {
    expect(classify('packages/api/src/resolvers/table.ts', rules)).toBe('source');
    expect(classify('testing-library-notes.md', [])).toBe('source');
  });
});
