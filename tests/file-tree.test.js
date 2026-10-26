import { describe, it, expect } from 'vitest';
import { buildFileTree, filesUnder, treeOrder } from '../client/file-tree.js';

const f = (name) => ({ name });

describe('buildFileTree', () => {
  const tree = buildFileTree(
    ['packages/api/src/b.ts', 'packages/api/src/a.ts', 'packages/web/x.ts', 'README.md', 'packages/api/src/util/c.ts'].map(f),
  );

  it('merges single-child directory chains into one row', () => {
    expect(tree.dirs.map((d) => d.name)).toEqual(['packages']);
    const [api, web] = tree.dirs[0].dirs;
    expect(api.name).toBe('api/src');
    expect(api.path).toBe('packages/api/src');
    expect(web.name).toBe('web');
  });

  it('sorts folders before files, alphabetically, depth-first', () => {
    expect(treeOrder(tree).map((x) => x.name)).toEqual([
      'packages/api/src/util/c.ts',
      'packages/api/src/a.ts',
      'packages/api/src/b.ts',
      'packages/web/x.ts',
      'README.md',
    ]);
  });

  it('lists every file under a folder', () => {
    expect(filesUnder(tree.dirs[0].dirs[0]).map((x) => x.name)).toEqual([
      'packages/api/src/util/c.ts',
      'packages/api/src/a.ts',
      'packages/api/src/b.ts',
    ]);
  });

  it('does not merge a folder that also has files', () => {
    const t = buildFileTree(['a/x.ts', 'a/b/y.ts'].map(f));
    expect(t.dirs[0].name).toBe('a');
    expect(t.dirs[0].dirs[0].name).toBe('b');
  });
});
