// Review page: one PR's diff between any two of its versions, rendered with @pierre/diffs CodeView,
// with per-file "viewed" tracking and GitHub comment threads inline.
//
// URL: /review?repo=owner/name&number=N[&base=SHA][&head=SHA][&tab=conversation][&embed=1]
//   no base → whole PR (merge base → head); no head → latest commit.
//   embed=1 → shown in the dashboard's side panel, which provides its own title bar.

import { CodeView, parseDiffFromFile, parsePatchFiles } from '@pierre/diffs';

import { applyTheme, getTheme, onThemeChange, themeToggle } from '../public/theme.js';
import { buildFileTree, filesUnder, treeOrder } from './file-tree.js';
import { placeThread } from './thread-placement.js';

const params = new URLSearchParams(location.search);
const repo = params.get('repo');
const number = params.get('number');
let base = params.get('base') || '';
let head = params.get('head') || '';
let tab = params.get('tab') === 'conversation' ? 'conversation' : 'files';

const $ = (id) => document.getElementById(id);
const viewerRoot = $('viewer');

let conversation = null; // /api/review/conversation, loaded in the background
let meta = null; // /api/review
let diff = null; // /api/review/diff
let files = []; // diff.files plus derived state, in display order
let viewer = null;
const embedded = params.get('embed') === '1';
document.body.classList.toggle('embedded', embedded);

// Split or unified, remembered separately for the panel and the full page. Until you pick one,
// it follows the available width.
const DIFF_STYLE_KEY = embedded ? 'diffStyle.panel' : 'diffStyle.page';
const SPLIT_MIN_WIDTH = 1000;
let diffStyle = pref(DIFF_STYLE_KEY, null);
const effectiveDiffStyle = () => diffStyle || (viewerRoot.clientWidth >= SPLIT_MIN_WIDTH ? 'split' : 'unified');
let renderedDiffStyle = null;

let sidebarMode = pref('sidebarMode', 'tree'); // 'tree' | 'flat'
const foldedGroups = new Set(); // sections and folders folded in the sidebar

// The server tags each file (lib/classify.js); changes come first, then tests, then generated files,
// in the sidebar and in the diff.
const SECTIONS = [
  ['source', 'Changes'],
  ['test', 'Tests'],
  ['generated', 'Generated'],
];
let sections = []; // [{ key, label, tree, files }], non-empty only

// --- Small helpers ---

function pref(key, fallback) {
  try {
    const v = localStorage.getItem(`critique.${key}`);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}
function setPref(key, value) {
  try {
    localStorage.setItem(`critique.${key}`, JSON.stringify(value));
  } catch {
    // storage unavailable; preference just won't persist
  }
}

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el[k] = v;
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

async function getJSON(path) {
  const res = await fetch(path);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

async function postJSON(path, body) {
  await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

function timeAgo(ms) {
  if (!ms) return '';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const hr = Math.round(m / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.round(hr / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ms).toLocaleDateString();
}

const short = (sha) => sha.slice(0, 7);
const qs = (obj) =>
  new URLSearchParams(Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== '' && v != null))).toString();

// GitHub renders and sanitizes comment HTML; strip anything executable anyway before inserting it.
function sanitizedFragment(html) {
  const doc = new DOMParser().parseFromString(html || '', 'text/html');
  doc.querySelectorAll('script, style, iframe, object, embed, link, meta, form, base').forEach((n) => n.remove());
  for (const el of doc.body.querySelectorAll('*')) {
    for (const attr of [...el.attributes]) {
      const unsafeUrl = (attr.name === 'href' || attr.name === 'src') && /^\s*javascript:/i.test(attr.value);
      if (attr.name.startsWith('on') || unsafeUrl) el.removeAttribute(attr.name);
    }
  }
  for (const a of doc.body.querySelectorAll('a')) {
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  }
  const frag = document.createDocumentFragment();
  frag.append(...doc.body.childNodes);
  return frag;
}

// --- Files and viewed state ---

const viewedKey = (file) => file.blobSha || 'deleted';
const isViewed = (file) => meta.viewed[file.name] === viewedKey(file);
// You marked an earlier version of this file as viewed, and it has changed since.
const changedSinceViewed = (file) => !!meta.viewed[file.name] && !isViewed(file);

async function setViewed(file, viewed) {
  await setViewedMany([file], viewed);
}

// Mark several files at once, e.g. everything in a folder.
async function setViewedMany(list, viewed) {
  for (const file of list) {
    if (viewed) meta.viewed[file.name] = viewedKey(file);
    else delete meta.viewed[file.name];
    file.collapsed = viewed;
    updateItem(file);
  }
  renderSidebar();
  renderProgress();
  await Promise.all(
    list.map((file) => postJSON('/api/review/viewed', { url: meta.pr.url, path: file.name, blobSha: viewed ? viewedKey(file) : null })),
  );
}

function toggleCollapsed(file) {
  file.collapsed = !file.collapsed;
  updateItem(file);
}

// --- Threads ---

function threadStatus(t) {
  if (t.isResolved) return ['resolved', 'Resolved'];
  if (t.isOutdated) return ['outdated', 'Outdated'];
  if (t.waitingOnMe) return ['waiting', 'Waiting on you'];
  return ['open', 'Open'];
}

function threadElement(thread, { location = null } = {}) {
  const [statusClass, statusText] = threadStatus(thread);
  const first = thread.comments[0];
  const details = h(
    'details',
    { class: `thread ${statusClass}`, open: !thread.isResolved && !thread.isOutdated },
    h(
      'summary',
      null,
      h('span', { class: `pill ${statusClass}` }, statusText),
      h('span', { class: 'muted' }, ` ${first?.author || ''} · ${thread.comments.length} comment${thread.comments.length === 1 ? '' : 's'}`),
      location && h('span', { class: 'muted' }, ` · ${location}`),
    ),
    thread.comments.map((c) =>
      h(
        'div',
        { class: 'comment' },
        h(
          'div',
          { class: 'comment-meta' },
          h('b', null, c.author),
          ' · ',
          h('a', { href: c.url, target: '_blank', rel: 'noopener' }, timeAgo(new Date(c.createdAt).getTime())),
        ),
        h('div', { class: 'comment-body markdown' }, sanitizedFragment(c.bodyHTML)),
      ),
    ),
    h('a', { class: 'reply', href: thread.comments.at(-1)?.url, target: '_blank', rel: 'noopener' }, 'Reply on GitHub →'),
  );
  return h('div', { class: 'thread-wrap' }, details);
}

// Where each thread attaches: on its line when we can find it in this diff (see thread-placement.js),
// otherwise at the top of the file with its line number.
function annotationsFor(file, fileDiff) {
  const view = { head: diff.head, latestHead: meta.pr.headSha, fromMergeBase: !base };
  return threadsFor(file).map((thread) => {
    const { side, lineNumber, label } = placeThread(thread, fileDiff, view);
    return { side, lineNumber, metadata: { thread, location: label } };
  });
}

// Scroll to the first thread waiting on you in a file (or its first open thread), expanding the file if needed.
function jumpToThread(file) {
  if (file.collapsed) toggleCollapsed(file);
  const anns = annotationsFor(file, file.fileDiff);
  const target =
    anns.find((a) => a.metadata.thread.waitingOnMe && a.lineNumber > 0) ||
    anns.find((a) => !a.metadata.thread.isResolved && a.lineNumber > 0);
  if (target) viewer?.scrollTo({ type: 'line', id: file.name, lineNumber: target.lineNumber, side: target.side, align: 'center' });
  else viewer?.scrollTo({ type: 'item', id: file.name, align: 'start' });
}

const threadsFor = (file) => meta.threads.filter((t) => t.path === file.name || (file.prevName && t.path === file.prevName));

// --- CodeView items ---

function patchFor(file) {
  const oldPath = file.prevName || file.name;
  const lines = [`diff --git a/${oldPath} b/${file.name}`];
  if (file.prevName) lines.push(`rename from ${oldPath}`, `rename to ${file.name}`);
  if (file.status === 'added') lines.push('new file mode 100644');
  if (file.status === 'removed') lines.push('deleted file mode 100644');
  lines.push(
    `--- ${file.status === 'added' ? '/dev/null' : `a/${oldPath}`}`,
    `+++ ${file.status === 'removed' ? '/dev/null' : `b/${file.name}`}`,
    file.patch,
  );
  return parsePatchFiles(`${lines.join('\n')}\n`)[0]?.files[0] ?? null;
}

function fileDiffFor(file) {
  if (diff.mode === 'snapshot') {
    const oldFile = file.oldContents == null ? null : { name: file.prevName || file.name, contents: file.oldContents };
    const newFile = file.newContents == null ? null : { name: file.name, contents: file.newContents };
    return parseDiffFromFile(oldFile, newFile);
  }
  return file.patch == null ? null : patchFor(file);
}

function placeholderText(file) {
  if (file.status === 'renamed' && !file.additions && !file.deletions) return `Renamed from ${file.prevName} with no changes.`;
  return 'Binary file, or a diff too large for GitHub to return. Open the PR on GitHub to see it.';
}

function itemFor(file) {
  const common = { id: file.name, version: file.version, collapsed: file.collapsed };
  if (file.fileDiff) return { ...common, type: 'diff', fileDiff: file.fileDiff, annotations: annotationsFor(file, file.fileDiff) };
  return {
    ...common,
    type: 'file',
    file: { name: file.name, contents: placeholderText(file), lang: 'text' },
    annotations: annotationsFor(file, null).map(({ lineNumber, metadata }) => ({ lineNumber, metadata })),
  };
}

function updateItem(file) {
  file.version += 1;
  viewer?.updateItem(itemFor(file));
}

// Full contents for expanding context in patch-based diffs.
async function loadDiffFiles(fileDiff) {
  const file = files.find((f) => f.name === fileDiff.name || f.prevName === fileDiff.name);
  const load = async (ref, path) => {
    const res = await fetch(`/api/review/file?${qs({ repo, ref, path })}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Could not load ${path}`);
    return { name: path, contents: await res.text() };
  };
  const oldPath = file?.prevName || fileDiff.prevName || fileDiff.name;
  const [oldFile, newFile] = await Promise.all([load(file?.oldRef || diff.base, oldPath), load(file?.newRef || diff.head, fileDiff.name)]);
  return { oldFile, newFile };
}

function headerPrefix(_fileDiffOrFile, context) {
  const file = files.find((f) => f.name === context?.item?.id);
  if (!file) return null;
  const box = h('input', { type: 'checkbox', checked: isViewed(file), title: 'Mark this file as viewed' });
  box.onclick = (e) => e.stopPropagation();
  box.onchange = () => setViewed(file, box.checked);
  const toggle = h('button', { class: 'collapse-toggle', title: file.collapsed ? 'Expand' : 'Collapse' }, file.collapsed ? '▸' : '▾');
  toggle.onclick = (e) => {
    e.stopPropagation();
    toggleCollapsed(file);
  };
  return h('span', { class: 'file-prefix' }, toggle, h('label', { class: 'viewed-box' }, box, 'Viewed'));
}

function headerMetadata(_fileDiffOrFile, context) {
  const file = files.find((f) => f.name === context?.item?.id);
  if (!file) return null;
  const threads = threadsFor(file);
  const waiting = threads.filter((t) => t.waitingOnMe).length;
  const open = threads.filter((t) => !t.isResolved).length;
  return h(
    'span',
    { class: 'file-tags' },
    changedSinceViewed(file) && h('span', { class: 'tag changed' }, 'Changed since you viewed'),
    file.section === 'generated' && h('span', { class: 'tag' }, 'Generated'),
    file.section === 'test' && h('span', { class: 'tag' }, 'Test'),
    waiting > 0 && h('span', { class: 'tag waiting' }, `${waiting} waiting on you`),
    open > waiting && h('span', { class: 'tag' }, `${open - waiting} open`),
  );
}

function renderAnnotation(annotation) {
  const { thread, location } = annotation.metadata || {};
  return thread ? threadElement(thread, { location }) : undefined;
}

function viewerOptions() {
  return {
    theme: { dark: 'pierre-dark', light: 'pierre-light' },
    themeType: getTheme(), // 'system' | 'light' | 'dark', same values diffs uses
    diffStyle: effectiveDiffStyle(),
    stickyHeaders: true,
    hunkSeparators: 'line-info-basic',
    lineDiffType: 'word-alt',
    overflow: 'scroll',
    layout: { paddingTop: 12, paddingBottom: 48, gap: 12 },
    loadDiffFiles,
    renderHeaderPrefix: headerPrefix,
    renderHeaderMetadata: headerMetadata,
    renderAnnotation,
  };
}

function renderViewer() {
  if (!viewer) {
    viewerRoot.replaceChildren();
    renderedDiffStyle = effectiveDiffStyle();
    viewer = new CodeView(viewerOptions());
    viewer.setup(viewerRoot);
  }
  viewer.setItems(files.map(itemFor));
}

function applyDiffStyle() {
  if (effectiveDiffStyle() === renderedDiffStyle) return;
  renderedDiffStyle = effectiveDiffStyle();
  viewer?.setOptions(viewerOptions());
  viewer?.render();
  if (meta) renderToolbar();
}

function setDiffStyle(style) {
  diffStyle = style;
  setPref(DIFF_STYLE_KEY, style);
  applyDiffStyle();
}

// Re-pick split/unified as the panel is resized (only while you haven't chosen one).
new ResizeObserver(() => applyDiffStyle()).observe(viewerRoot);

// --- Chrome around the viewer ---

function revisionLabel(rev, i) {
  const when = rev.at ? new Date(rev.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
  const labels = rev.labels.filter(Boolean).join(', ');
  const name = rev.isHead ? 'Latest' : `v${i + 1}`;
  return [name, short(rev.sha), when, labels].filter(Boolean).join(' · ').slice(0, 110);
}

const currentQuery = () => qs({ repo, number, base, head, tab: tab === 'conversation' ? 'conversation' : '' });

function syncUrl() {
  history.replaceState(null, '', `/review?${currentQuery()}${embedded ? '&embed=1' : ''}`);
  // Keep the dashboard's URL in step so a reload or "Open in new tab" shows the same view.
  if (embedded) parent.postMessage({ type: 'critique:navigate', query: currentQuery() }, location.origin);
}

function navigate(next) {
  base = next.base ?? base;
  head = next.head ?? head;
  if (next.tab) tab = next.tab;
  syncUrl();
  showTab();
  loadDiff();
}

function setTab(next) {
  tab = next;
  syncUrl();
  showTab();
}

function showTab() {
  const onConversation = tab === 'conversation';
  document.querySelector('.review-layout').hidden = onConversation;
  $('conversation').hidden = !onConversation;
  $('banners').hidden = onConversation; // they describe the diff
  if (onConversation) renderConversation();
  // CodeView measures its container, so re-render once it's visible again.
  else requestAnimationFrame(() => viewer?.render());
  if (meta) renderToolbar();
}

function tabsControl() {
  const fresh = conversation ? newSinceMyReview(conversation).length : 0;
  return h(
    'span',
    { class: 'segmented tabs' },
    h('button', { class: tab === 'files' ? 'active' : '', onclick: () => setTab('files') }, 'Files'),
    h(
      'button',
      { class: tab === 'conversation' ? 'active' : '', onclick: () => setTab('conversation') },
      'Conversation',
      fresh > 0 && h('span', { class: 'tab-count', title: 'New since your last review' }, fresh),
    ),
  );
}

function renderToolbar() {
  if (tab === 'conversation') {
    $('toolbar').replaceChildren(tabsControl());
    return;
  }
  const revisions = meta.revisions;
  const baseSelect = h(
    'select',
    { 'aria-label': 'Compare from' },
    h('option', { value: '' }, `Base of ${meta.pr.baseRef} (whole PR)`),
    revisions.filter((r) => !r.isHead).map((r, i) => h('option', { value: r.sha }, revisionLabel(r, i))),
  );
  baseSelect.value = base;
  baseSelect.onchange = () => navigate({ base: baseSelect.value });

  const headSelect = h(
    'select',
    { 'aria-label': 'Compare to' },
    revisions.map((r, i) => h('option', { value: r.isHead ? '' : r.sha }, revisionLabel(r, i))),
  );
  headSelect.value = head;
  headSelect.onchange = () => navigate({ head: headSelect.value });

  const sinceMine = meta.myLastReviewCommit && meta.myLastReviewCommit !== meta.pr.headSha;
  const quick = h(
    'span',
    { class: 'segmented' },
    h('button', { class: !base && !head ? 'active' : '', onclick: () => navigate({ base: '', head: '' }) }, 'Whole PR'),
    sinceMine &&
      h(
        'button',
        { class: base === meta.myLastReviewCommit && !head ? 'active' : '', onclick: () => navigate({ base: meta.myLastReviewCommit, head: '' }) },
        'Since your review',
      ),
  );

  const style = h(
    'span',
    { class: 'segmented' },
    h('button', { class: effectiveDiffStyle() === 'split' ? 'active' : '', onclick: () => setDiffStyle('split') }, 'Split'),
    h('button', { class: effectiveDiffStyle() === 'unified' ? 'active' : '', onclick: () => setDiffStyle('unified') }, 'Unified'),
  );

  // On narrow widths the file list becomes an overlay opened from here.
  const filesBtn = h('button', { class: 'files-toggle', onclick: () => document.body.classList.toggle('files-open') }, `Files (${files.length})`);

  $('toolbar').replaceChildren(
    tabsControl(),
    filesBtn,
    quick,
    h('span', { class: 'compare' }, h('span', { class: 'compare-label' }, 'Compare'), baseSelect, '→', headSelect),
    h('span', { class: 'spacer' }),
    h('span', { id: 'progress', class: 'muted' }),
    style,
  );
  renderProgress();
}

function renderProgress() {
  const el = $('progress');
  if (!el || !files.length) return;
  const viewed = files.filter(isViewed).length;
  el.textContent = `${viewed} of ${files.length} files viewed`;
}

const STATUS = { added: ['A', 'added'], removed: ['D', 'removed'], renamed: ['R', 'renamed'], copied: ['C', 'renamed'] };

const indent = (depth) => `padding-left: ${16 + depth * 14}px`;

function scrollToFile(file) {
  document.body.classList.remove('files-open');
  viewer?.scrollTo({ type: 'item', id: file.name, align: 'start' });
}

function fileRow(file, { depth = 0, showDir = true } = {}) {
  const [letter, cls] = STATUS[file.status] || ['M', 'modified'];
  const slash = file.name.lastIndexOf('/');
  const waiting = threadsFor(file).filter((t) => t.waitingOnMe).length;
  const box = h('input', { type: 'checkbox', checked: isViewed(file), title: 'Viewed', 'aria-label': `Mark ${file.name} viewed` });
  box.onchange = () => setViewed(file, box.checked);
  return h(
    'li',
    { class: isViewed(file) ? 'viewed' : '', style: indent(depth) },
    box,
    h(
      'button',
      { class: 'file-link', title: file.name, onclick: () => scrollToFile(file) },
      h('span', { class: `status ${cls}` }, letter),
      h(
        'span',
        { class: 'path' },
        // The LRM marks keep punctuation in place inside the right-to-left truncation (".yarn/" not "/yarn.").
        showDir && slash >= 0 && h('span', { class: 'dir' }, `\u200E${file.name.slice(0, slash + 1)}\u200E`),
        h('span', { class: 'base' }, file.name.slice(slash + 1)),
      ),
    ),
    changedSinceViewed(file) && h('span', { class: 'dot-changed', title: 'Changed since you viewed it' }),
    waiting > 0 && h('button', { class: 'tag waiting', title: 'Jump to threads waiting on you', onclick: () => jumpToThread(file) }, waiting),
    file.additions != null &&
      h('span', { class: 'stat' }, h('span', { class: 'add' }, `+${file.additions}`), ' ', h('span', { class: 'del' }, `−${file.deletions}`)),
  );
}

// A foldable sidebar row for a section or folder: mark-all checkbox, fold toggle, and counts.
function groupRow({ key, label, title, under, depth, className }) {
  const viewedCount = under.filter(isViewed).length;
  const waiting = under.reduce((n, f) => n + threadsFor(f).filter((t) => t.waitingOnMe).length, 0);
  const folded = foldedGroups.has(key);

  const box = h('input', {
    type: 'checkbox',
    checked: viewedCount === under.length,
    title: `Mark every file in ${title} viewed`,
    'aria-label': `Mark all files in ${title} viewed`,
  });
  box.indeterminate = viewedCount > 0 && viewedCount < under.length;
  box.onchange = () => setViewedMany(under, box.checked);

  const toggle = () => {
    if (folded) foldedGroups.delete(key);
    else foldedGroups.add(key);
    renderSidebar();
  };

  const row = h(
    'li',
    { class: `${className}${viewedCount === under.length ? ' viewed' : ''}`, style: indent(depth) },
    box,
    h(
      'button',
      { class: 'file-link dir-link', title, 'aria-expanded': String(!folded), onclick: toggle },
      h('span', { class: 'fold' }, folded ? '▸' : '▾'),
      h('span', { class: 'path' }, h('span', { class: 'base' }, label)),
    ),
    under.some(changedSinceViewed) && h('span', { class: 'dot-changed', title: 'A file here changed since you viewed it' }),
    waiting > 0 && h('span', { class: 'tag waiting', title: 'Threads waiting on you' }, waiting),
    h('span', { class: 'dir-count', title: 'Files viewed' }, `${viewedCount}/${under.length}`),
  );
  return { row, folded };
}

function dirRows(dir, depth, sectionKey) {
  const { row, folded } = groupRow({
    key: `dir:${sectionKey}:${dir.path}`,
    label: `${dir.name}/`,
    title: dir.path,
    under: filesUnder(dir),
    depth,
    className: 'dir-row',
  });
  if (folded) return [row];
  return [row, ...treeRows(dir, depth + 1, sectionKey)];
}

function treeRows(dir, depth, sectionKey) {
  return [...dir.dirs.flatMap((d) => dirRows(d, depth, sectionKey)), ...dir.files.map((f) => fileRow(f, { depth, showDir: false }))];
}

function renderSidebar() {
  // Section headers only matter once there's something besides regular changes.
  const showSections = sections.some((sec) => sec.key !== 'source');
  const rows = sections.flatMap((sec) => {
    const depth = showSections ? 1 : 0;
    const body = sidebarMode === 'tree' ? treeRows(sec.tree, depth, sec.key) : sec.files.map((f) => fileRow(f, { depth }));
    if (!showSections) return body;
    const { row, folded } = groupRow({
      key: `section:${sec.key}`,
      label: sec.label,
      title: sec.label.toLowerCase(),
      under: sec.files,
      depth: 0,
      className: `section-row section-${sec.key}`,
    });
    return folded ? [row] : [row, ...body];
  });

  const setMode = (mode) => {
    sidebarMode = mode;
    setPref('sidebarMode', mode);
    renderSidebar();
  };
  const modeToggle = h(
    'span',
    { class: 'segmented small' },
    h('button', { class: sidebarMode === 'tree' ? 'active' : '', onclick: () => setMode('tree') }, 'Tree'),
    h('button', { class: sidebarMode === 'flat' ? 'active' : '', onclick: () => setMode('flat') }, 'Flat'),
  );

  $('sidebar').replaceChildren(
    h('div', { class: 'sidebar-title' }, h('span', null, `Files (${files.length})`), modeToggle),
    h('ul', { class: 'file-list' }, rows),
  );
}

function renderBanners(extra = []) {
  const banners = [...extra];
  if (diff?.mode === 'snapshot') {
    banners.push(
      h(
        'div',
        { class: 'banner info' },
        'The branch was rebased between these versions, so this compares each file the PR touches as it was in each version. Changes that came in from the base branch may also show up.',
      ),
    );
  }
  if (diff?.truncated) banners.push(h('div', { class: 'banner' }, 'Showing only part of a very large diff. Open the PR on GitHub for the rest.'));

  const shownPaths = new Set(files.flatMap((f) => [f.name, f.prevName]));
  const elsewhere = meta?.threads.filter((t) => !t.isResolved && !shownPaths.has(t.path)) || [];
  if (elsewhere.length) {
    banners.push(
      h(
        'details',
        { class: 'banner info threads-elsewhere' },
        h('summary', null, `${elsewhere.length} open thread${elsewhere.length === 1 ? '' : 's'} on files not in this comparison`),
        elsewhere.map((t) => h('div', null, h('code', null, t.path), ' ', threadElement(t, { location: t.line ? `line ${t.line}` : null }))),
      ),
    );
  }
  $('banners').replaceChildren(...banners);
}

function renderHeading() {
  const { pr } = meta;
  document.title = `${pr.title} · Critique`;
  $('pr-heading').className = 'pr-heading';
  $('pr-heading').replaceChildren(
    ...[
      h('span', { class: 'pr-title' }, pr.title),
      h('span', { class: 'muted' }, ` ${pr.repo}#${pr.number} · by ${pr.author}`),
      pr.state !== 'open' && h('span', { class: 'badge' }, pr.state),
      pr.draft && h('span', { class: 'badge' }, 'draft'),
    ].filter(Boolean),
  );
  $('github-link').href = pr.url;
  $('github-link').hidden = false;
}

// --- Conversation ---

const versionName = (sha) => {
  const i = meta.revisions.findIndex((r) => r.sha === sha);
  if (i === -1) return null;
  return meta.revisions[i].isHead ? 'latest' : `v${i + 1}`;
};

function lastMyReviewAt(conv) {
  const mine = conv.items.filter((i) => i.kind === 'review' && i.author === meta.me);
  return mine.length ? new Date(mine.at(-1).at).getTime() : 0;
}

// Timeline entries after your most recent review, written by someone else.
function newSinceMyReview(conv) {
  const since = lastMyReviewAt(conv);
  if (!since) return [];
  return timelineEntries(conv).filter((e) => e.time > since && e.author !== meta.me);
}

/**
 * The conversation as display entries, oldest first: consecutive commits grouped into one push, and
 * inline threads nested under the review that started them (or placed at their first comment).
 */
function timelineEntries(conv) {
  const entries = [];
  let lastSha = ''; // '' = merge base, so the first push compares against the PR's base
  for (const item of conv.items) {
    const time = new Date(item.at).getTime();
    if (item.kind === 'commit') {
      const prev = entries.at(-1);
      if (prev?.kind === 'push' && prev.author === item.author) prev.commits.push(item);
      else entries.push({ kind: 'push', author: item.author, time, before: lastSha, commits: [item] });
      lastSha = item.sha;
    } else {
      if (item.kind === 'force-push') lastSha = item.after || lastSha;
      entries.push({ ...item, time });
    }
  }
  const reviews = new Map(entries.filter((e) => e.kind === 'review').map((e) => [e.id, e]));
  for (const thread of meta.threads) {
    const first = thread.comments[0];
    if (!first) continue;
    const review = reviews.get(thread.reviewId);
    if (review) (review.threads ??= []).push(thread);
    else entries.push({ kind: 'thread', author: first.author, time: new Date(first.createdAt).getTime(), thread });
  }
  return entries.sort((a, b) => a.time - b.time);
}

function when(time, url) {
  const text = timeAgo(time);
  const title = new Date(time).toLocaleString();
  return url ? h('a', { href: url, target: '_blank', rel: 'noopener', title }, text) : h('span', { title }, text);
}

const REVIEW_VERB = { approved: 'approved', changes_requested: 'requested changes', commented: 'reviewed', dismissed: 'reviewed (dismissed)' };

function compareLink(label, compare) {
  return h(
    'button',
    {
      class: 'link-button',
      onclick: () => navigate({ ...compare, head: compare.head === meta.pr.headSha ? '' : compare.head, tab: 'files' }),
    },
    `${label} →`,
  );
}

function conversationEntry(e) {
  switch (e.kind) {
    case 'comment':
      return h(
        'div',
        { class: 'conv-card' },
        h('div', { class: 'conv-head' }, h('b', null, e.author), ' commented · ', when(e.time, e.url)),
        h('div', { class: 'conv-body markdown' }, sanitizedFragment(e.bodyHTML)),
      );
    case 'review': {
      const hasBody = !!e.bodyHTML?.trim();
      const threads = (e.threads || []).map(threadBlock);
      const head = h(
        'div',
        { class: 'conv-head' },
        h('b', null, e.author),
        ' ',
        h('span', { class: `pill review-${e.state}` }, REVIEW_VERB[e.state] || e.state),
        e.commit && versionName(e.commit) && h('span', { class: 'muted' }, ` on ${versionName(e.commit)}`),
        ' · ',
        when(e.time, e.url),
        e.inlineComments > 0 && h('span', { class: 'muted' }, ` · ${e.inlineComments} inline comment${e.inlineComments === 1 ? '' : 's'}`),
      );
      if (!hasBody && !threads.length) return h('div', { class: 'conv-event' }, head);
      return h(
        'div',
        { class: 'conv-card' },
        head,
        hasBody && h('div', { class: 'conv-body markdown' }, sanitizedFragment(e.bodyHTML)),
        threads.length > 0 && h('div', { class: 'conv-threads' }, threads),
      );
    }
    case 'push': {
      const last = e.commits.at(-1).sha;
      const version = versionName(last);
      return h(
        'div',
        { class: 'conv-event push' },
        h(
          'div',
          null,
          h('b', null, e.author),
          ` added ${e.commits.length} commit${e.commits.length === 1 ? '' : 's'}`,
          version && h('span', { class: 'version' }, version),
          ' · ',
          when(e.time),
          ' · ',
          compareLink('View these changes', { base: e.before, head: last }),
        ),
        h(
          'ul',
          { class: 'commit-list' },
          e.commits.map((c) => h('li', null, h('code', null, short(c.sha)), ' ', c.message)),
        ),
      );
    }
    case 'force-push':
      return h(
        'div',
        { class: 'conv-event' },
        h('b', null, e.author),
        ' force-pushed',
        e.before && e.after && [' from ', h('code', null, short(e.before)), ' to ', h('code', null, short(e.after))],
        e.after && versionName(e.after) && h('span', { class: 'version' }, versionName(e.after)),
        ' · ',
        when(e.time),
        e.before && e.after && [' · ', compareLink('Compare', { base: e.before, head: e.after })],
      );
    case 'thread':
      return h('div', { class: 'conv-card' }, threadBlock(e.thread));
    default:
      return h('div', { class: 'conv-event' }, h('b', null, e.author), ` ${e.text} · `, when(e.time));
  }
}

// One inline thread: its file, a link into the diff, and the comments.
function threadBlock(t) {
  const file = files.find((f) => threadsFor(f).includes(t));
  return h(
    'div',
    { class: 'conv-thread' },
    h(
      'div',
      { class: 'conv-head' },
      h('code', null, t.path),
      ' · ',
      file
        ? h('button', { class: 'link-button', onclick: () => goToThread(file, t) }, 'View in diff →')
        : h('a', { href: t.comments[0].url, target: '_blank', rel: 'noopener' }, 'View on GitHub →'),
    ),
    threadElement(t, { location: t.line ? `line ${t.line}` : t.originalLine ? `was line ${t.originalLine}` : null }),
  );
}

// Switch to the diff and scroll to one thread.
function goToThread(file, thread) {
  setTab('files');
  if (file.collapsed) toggleCollapsed(file);
  const ann = annotationsFor(file, file.fileDiff).find((a) => a.metadata.thread === thread);
  requestAnimationFrame(() => {
    if (ann?.lineNumber > 0) viewer?.scrollTo({ type: 'line', id: file.name, lineNumber: ann.lineNumber, side: ann.side, align: 'center' });
    else viewer?.scrollTo({ type: 'item', id: file.name, align: 'start' });
  });
}

function renderConversation() {
  const root = $('conversation');
  if (!conversation) {
    root.replaceChildren(h('p', { class: 'empty' }, 'Loading conversation…'));
    return;
  }
  const since = lastMyReviewAt(conversation);
  const nodes = [
    h(
      'div',
      { class: 'conv-card description' },
      h('div', { class: 'conv-head' }, h('b', null, conversation.author), ' opened this PR · ', when(new Date(conversation.createdAt).getTime())),
      conversation.bodyHTML.trim()
        ? h('div', { class: 'conv-body markdown' }, sanitizedFragment(conversation.bodyHTML))
        : h('div', { class: 'conv-body muted' }, 'No description.'),
    ),
  ];
  let dividerShown = false;
  for (const e of timelineEntries(conversation)) {
    const isNew = since && e.time > since && e.author !== meta.me;
    if (isNew && !dividerShown) {
      nodes.push(h('div', { class: 'conv-divider' }, 'New since your last review'));
      dividerShown = true;
    }
    const el = conversationEntry(e);
    if (isNew) el.classList.add('new');
    nodes.push(el);
  }
  if (conversation.truncated) nodes.push(h('p', { class: 'muted' }, 'Older activity is cut off on very long PRs. Open GitHub for the full history.'));
  root.replaceChildren(h('div', { class: 'conv-list' }, nodes));
}

async function loadConversation() {
  try {
    conversation = await getJSON(`/api/review/conversation?${qs({ repo, number })}`);
  } catch (e) {
    $('conversation').replaceChildren(h('div', { class: 'banner' }, `Could not load the conversation: ${e.message}`));
    return;
  }
  if (tab === 'conversation') renderConversation();
  renderToolbar(); // the tab shows how many entries are new
}

// --- Loading ---

async function loadDiff() {
  viewerRoot.classList.add('loading');
  try {
    diff = await getJSON(`/api/review/diff?${qs({ repo, number, base, head })}`);
    files = diff.files.map((f) => {
      const file = { ...f, version: 0 };
      file.collapsed = isViewed(file);
      try {
        file.fileDiff = fileDiffFor(file);
      } catch (e) {
        console.error(`Could not parse diff for ${file.name}`, e);
        file.fileDiff = null;
      }
      return file;
    });
    // Group into sections, each in tree order, and show files in that same order in the diff.
    sections = SECTIONS.map(([key, label]) => {
      const tree = buildFileTree(files.filter((f) => (f.section || 'source') === key));
      return { key, label, tree, files: treeOrder(tree) };
    }).filter((sec) => sec.files.length > 0);
    files = sections.flatMap((sec) => sec.files);
    renderToolbar();
    renderSidebar();
    renderBanners();
    if (tab === 'conversation') renderConversation(); // "View in diff" links need the loaded files
    if (files.length === 0) {
      viewer?.cleanUp();
      viewer = null;
      viewerRoot.replaceChildren(h('p', { class: 'empty' }, 'No differences between these versions.'));
    } else {
      renderViewer();
    }
  } catch (e) {
    renderBanners([h('div', { class: 'banner' }, `Could not load the diff: ${e.message}`)]);
  } finally {
    viewerRoot.classList.remove('loading');
  }
}

async function init() {
  if (!repo || !number) {
    $('pr-heading').textContent = 'Missing repo or PR number in the URL.';
    return;
  }
  try {
    meta = await getJSON(`/api/review?${qs({ repo, number })}`);
  } catch (e) {
    $('pr-heading').textContent = `Could not load the PR: ${e.message}`;
    return;
  }
  renderHeading();
  showTab();
  loadConversation();
  await loadDiff();
}

window.addEventListener('beforeunload', () => viewer?.cleanUp());

$('theme-slot').replaceWith(themeToggle());
onThemeChange(() => {
  viewer?.setOptions(viewerOptions());
  viewer?.render();
});
// The dashboard forwards theme changes to the panel's frame (see app.js).
window.addEventListener('message', (e) => {
  if (e.origin === location.origin && e.data?.type === 'critique:theme') applyTheme(e.data.theme);
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.target.closest?.('input, textarea, select')) return;
  if (document.body.classList.contains('files-open')) document.body.classList.remove('files-open');
  else if (embedded) parent.postMessage({ type: 'critique:close' }, location.origin);
});
init();
