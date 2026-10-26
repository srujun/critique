import { describe, it, expect } from 'vitest';
import { parseDiffFromFile } from '@pierre/diffs';
import { findAnchor, placeThread } from '../client/thread-placement.js';
import { anchorLines } from '../lib/threads.js';

const lines = (n, fn) => Array.from({ length: n }, (_, i) => fn(i + 1)).join('\n') + '\n';
// A file where line 20 changes; everything else is plain numbered code.
const oldFile = { name: 'a.ts', contents: lines(40, (i) => `const v${i} = ${i};`) };
const newFile = {
  name: 'a.ts',
  contents: lines(5, (i) => `// header ${i}`) + lines(40, (i) => (i === 20 ? 'const v20 = "changed";' : `const v${i} = ${i};`)),
};
const fileDiff = parseDiffFromFile(oldFile, newFile);
const view = { head: 'HEAD', latestHead: 'HEAD', fromMergeBase: true };

describe('anchorLines', () => {
  it('keeps the commented side and drops the hunk header', () => {
    const hunk = '@@ -1,3 +1,3 @@\n a\n-b\n+c\n d';
    expect(anchorLines(hunk, 'additions')).toEqual(['a', 'c', 'd']);
    expect(anchorLines(hunk.replace(/\n d$/, ''), 'deletions')).toEqual(['a', 'b']);
  });
});

describe('placeThread', () => {
  it('uses the exact line for a current thread', () => {
    const t = { isOutdated: false, line: 25, startLine: 23, side: 'additions', anchor: [] };
    expect(placeThread(t, fileDiff, view)).toEqual({ side: 'additions', lineNumber: 25, label: 'lines 23–25' });
  });

  it('carries an outdated thread forward to the same code', () => {
    // Written on line 20 before 5 header lines were added above it.
    const t = { isOutdated: true, line: null, originalLine: 20, side: 'additions', anchor: ['const v18 = 18;', 'const v19 = 19;', 'const v20 = "changed";'] };
    expect(placeThread(t, fileDiff, view)).toEqual({ side: 'additions', lineNumber: 25, label: 'line 25 (was line 20)' });
  });

  it('keeps an outdated thread at the top when its code is gone', () => {
    const t = { isOutdated: true, line: null, originalLine: 9, side: 'additions', anchor: ['nothing like this exists'] };
    expect(placeThread(t, fileDiff, view)).toEqual({ side: 'additions', lineNumber: 0, label: 'was line 9 · code has since changed' });
  });

  it('uses original line numbers when viewing the version the thread was written on', () => {
    const t = { isOutdated: true, line: null, originalLine: 21, originalStartLine: 19, originalCommit: 'HEAD', side: 'additions', anchor: [] };
    expect(placeThread(t, fileDiff, view)).toEqual({ side: 'additions', lineNumber: 21, label: 'lines 19–21' });
  });
});

describe('findAnchor', () => {
  const rows = [
    { lineNumber: 10, text: '  }' },
    { lineNumber: 11, text: 'foo();' },
    { lineNumber: 12, text: '  }' },
  ];

  it('refuses to guess for a short line with no matching context', () => {
    expect(findAnchor(rows, ['something else', '}'], 10)).toBe(null);
  });

  it('accepts a short line when the line above matches', () => {
    expect(findAnchor(rows, ['foo();', '}'], 0)).toBe(12);
  });
});
