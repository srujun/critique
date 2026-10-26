// Decides which diff line each GitHub comment thread attaches to on the review page.
//
// GitHub only gives exact line numbers for threads that are still current, and only relative to the
// PR's latest commit. Outdated threads (the code moved after later pushes) are carried forward by
// finding the code they were written on, the way Gerrit and Critique port comments across patchsets.

const MIN_DISTINCT_CHARS = 4; // "}" or ");" alone match too many places to trust

/** The rows a diff actually shows on one side, with their line numbers and text. */
export function sideLines(fileDiff, side) {
  const out = [];
  const text = side === 'additions' ? fileDiff.additionLines : fileDiff.deletionLines;
  for (const hunk of fileDiff.hunks) {
    let lineNumber = side === 'additions' ? hunk.additionStart : hunk.deletionStart;
    for (const part of hunk.hunkContent) {
      const count = part.type === 'context' ? part.lines : side === 'additions' ? part.additions : part.deletions;
      const start = side === 'additions' ? part.additionLineIndex : part.deletionLineIndex;
      for (let i = 0; i < count; i++) out.push({ lineNumber: lineNumber++, text: text[start + i] ?? '' });
    }
  }
  return out;
}

const norm = (s) => (s ?? '').replace(/\r?\n$/, '').trim();
const rangeLabel = (start, end) => (start && start !== end ? `lines ${start}–${end}` : `line ${end}`);

/**
 * Find the commented line in `rows` by matching it plus the lines above it. Returns the best row's line
 * number, or null when the code is gone or the match is too ambiguous to trust.
 */
export function findAnchor(rows, anchor, nearLine) {
  if (!anchor?.length) return null;
  const target = norm(anchor.at(-1));
  const context = anchor.slice(0, -1).map(norm);
  let best = null;
  rows.forEach((row, i) => {
    if (norm(row.text) !== target) return;
    let score = 0;
    for (let k = 1; k <= context.length; k++) {
      if (i - k < 0 || norm(rows[i - k].text) !== context[context.length - k]) break;
      score++;
    }
    const distance = Math.abs(row.lineNumber - (nearLine || row.lineNumber));
    if (!best || score > best.score || (score === best.score && distance < best.distance)) best = { lineNumber: row.lineNumber, score, distance };
  });
  if (!best) return null;
  // A short line like "}" only counts if the lines above it match too.
  if (target.replace(/\s/g, '').length < MIN_DISTINCT_CHARS && best.score === 0) return null;
  return best.lineNumber;
}

/**
 * @param {object} thread  from /api/review
 * @param {object|null} fileDiff  the diff shown for this file
 * @param {{ head: string, latestHead: string, fromMergeBase: boolean }} view
 * @returns {{ side: 'additions'|'deletions', lineNumber: number, label: string }}  lineNumber 0 = top of file
 */
export function placeThread(thread, fileDiff, view) {
  const top = (label) => ({ side: 'additions', lineNumber: 0, label });
  const fallbackLine = thread.line || thread.originalLine;
  // An outdated thread we couldn't carry forward points at code that has since changed or moved out of view.
  const fallbackLabel = !fallbackLine
    ? 'file'
    : thread.isOutdated
      ? `was ${rangeLabel(thread.originalStartLine, thread.originalLine)} · code has since changed`
      : rangeLabel(thread.startLine, thread.line);
  if (!fileDiff) return top(fallbackLabel);

  const rows = { additions: null, deletions: null };
  const rowsFor = (side) => (rows[side] ??= sideLines(fileDiff, side));
  const shows = (side, n) => rowsFor(side).some((r) => r.lineNumber === n);

  // Current thread, and this view ends at the latest commit: GitHub's line numbers are exact.
  // Left-side numbers refer to the merge base, so they only fit the whole-PR view.
  const atLatest = view.head === view.latestHead;
  if (!thread.isOutdated && thread.line && atLatest && (thread.side === 'additions' || view.fromMergeBase) && shows(thread.side, thread.line)) {
    return { side: thread.side, lineNumber: thread.line, label: rangeLabel(thread.startLine, thread.line) };
  }

  // Viewing the version the thread was written on: its original right-side numbers are exact.
  if (thread.originalCommit === view.head && thread.side === 'additions' && thread.originalLine && shows('additions', thread.originalLine)) {
    return { side: 'additions', lineNumber: thread.originalLine, label: rangeLabel(thread.originalStartLine, thread.originalLine) };
  }

  // Otherwise carry it forward to the same code, if it's still in this diff.
  const moved = findAnchor(rowsFor(thread.side), thread.anchor, thread.originalLine || thread.line);
  if (moved) {
    const was = thread.originalLine && thread.originalLine !== moved ? ` (was line ${thread.originalLine})` : '';
    return { side: thread.side, lineNumber: moved, label: `${rangeLabel(null, moved)}${was}` };
  }

  return top(fallbackLabel);
}
