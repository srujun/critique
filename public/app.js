// Dashboard UI. The server pushes the full view over SSE, and every render rebuilds the page from it.

import { getTheme, onThemeChange, themeToggle } from '/theme.js';

const app = document.getElementById('app');
const nav = document.getElementById('nav');
const dashboardControls = document.getElementById('dashboard-controls');
const search = document.getElementById('search');
const groupByRepoBox = document.getElementById('group-by-repo');
const refreshBtn = document.getElementById('refresh');

const STATE_LABELS = {
  DRAFT: 'Draft',
  REVIEWING: 'Review',
  CHANGES_REQUESTED: 'Fix',
  COMMENTED: 'Respond',
  APPROVED_NO_AUTOMERGE: 'Merge',
  MERGING: 'Merging',
  STALLED_MERGE: 'Stuck',
  MERGED: 'Merged',
  CLOSED: 'Closed',
};
const INCOMING_LABELS = { new: 'New', updated: 'Updated', rereview: 'Re-review' };
const ROLES = [
  ['incoming', 'Reviewing'],
  ['outgoing', 'Your PRs'],
  ['mentioned', 'Mentioned'],
  ['other', 'Other'],
];

let data = null;
let openMenu = null; // url of the PR whose mute menu is open
let dismissedOpen = false;
let settingsForm = null; // built once per visit so live updates don't wipe in-progress edits

const onSettingsPage = () => location.hash === '#settings';
window.onhashchange = () => {
  settingsForm = null;
  render();
  syncReviewPanel();
};

// --- Preferences (per browser, optional) ---

function pref(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}
function setPref(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage unavailable; preference just won't persist
  }
}

groupByRepoBox.checked = pref('groupByRepo', false);
groupByRepoBox.onchange = () => {
  setPref('groupByRepo', groupByRepoBox.checked);
  render();
};
search.oninput = () => render();

// --- Server calls ---

async function post(path, body = {}) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.ok) {
    data = await res.json();
    render();
  }
  return res.ok;
}

refreshBtn.onclick = () => post('/api/refresh');

function connect() {
  const events = new EventSource('/api/events');
  events.onmessage = (e) => {
    data = JSON.parse(e.data);
    render();
  };
  events.addEventListener('notify', (e) => showNotification(JSON.parse(e.data)));
}
connect();

// --- Browser notifications ---

// Inside the desktop app, notifications are native macOS ones sent by the app (desktop/main.js).
const inDesktopApp = !!window.critiqueDesktop;
const notificationsSupported = 'Notification' in window;
const notificationPermission = () => (notificationsSupported ? Notification.permission : 'unsupported');

function showNotification({ title, body, url, tag }) {
  if (inDesktopApp || notificationPermission() !== 'granted') return;
  const n = new Notification(title, { body, tag, icon: faviconHref() });
  n.onclick = () => {
    window.focus();
    // PR links open in a new tab; the dashboard's own link just focuses this tab.
    if (url && new URL(url).origin !== location.origin) window.open(url, '_blank');
    n.close();
  };
}

// Must be called from a click; browsers ignore permission prompts that aren't user-initiated.
async function enableNotifications() {
  if (notificationsSupported) await Notification.requestPermission();
  render();
}

// Re-render every 30s so relative times stay fresh.
setInterval(() => data && render(), 30_000);

// --- DOM helpers ---

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el[k] = v;
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v);
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
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

function setFavicon(count) {
  const fill = count > 0 ? '#d1242f' : '#8c959f';
  const label = count > 0 ? (count > 9 ? '9+' : String(count)) : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="15" fill="${fill}"/><text x="16" y="22" font-family="sans-serif" font-size="17" font-weight="700" text-anchor="middle" fill="#fff">${label}</text></svg>`;
  document.getElementById('favicon').href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const faviconHref = () => document.getElementById('favicon').href;

// --- Rendering ---

function matchesSearch(pr) {
  const q = search.value.trim().toLowerCase();
  if (!q) return true;
  const text = `${pr.title} ${pr.repo} ${pr.author} #${pr.number} ${(pr.allReviewers || []).join(' ')}`.toLowerCase();
  return q.split(/\s+/).every((term) => text.includes(term));
}

function stateLabel(pr) {
  if (pr.myRole === 'incoming' && INCOMING_LABELS[pr.incomingDetail]) return INCOMING_LABELS[pr.incomingDetail];
  return STATE_LABELS[pr.myReason || pr.prState] || '';
}

function markClicked(pr) {
  post('/api/clicked', { url: pr.url });
}

function reviewerList(pr) {
  const states = pr.reviewerStates || {};
  const set = pr.attentionSet || {};
  const names = (pr.allReviewers || []).filter((r) => r !== pr.author);
  if (names.length === 0) return null;
  const parts = [' · '];
  names.forEach((name, i) => {
    if (i > 0) parts.push(', ');
    const classes = ['reviewer', states[name] || 'pending', set[name] ? 'in-set' : ''].join(' ');
    parts.push(h('span', { class: classes, title: `${name}: ${states[name] || 'pending'}` }, name));
  });
  return parts;
}

function muteMenu(pr) {
  const owner = pr.repo.split('/')[0];
  // Only offer "Not my turn" when someone else would hold the turn: another person, or the author.
  const myTurn = pr.myStatus === 'red' || pr.myStatus === 'yellow';
  const canStepOut = myTurn && (pr.author !== data.username || Object.keys(pr.attentionSet || {}).some((u) => u !== data.username));
  return h(
    'div',
    { class: 'menu' },
    canStepOut &&
      h(
        'button',
        { title: 'Leave the attention set until someone else reviews, comments or pushes', onclick: () => post('/api/attention', { url: pr.url, mine: false }) },
        'Not my turn (until someone responds)',
      ),
    pr.steppedOutAt && h('button', { onclick: () => post('/api/attention', { url: pr.url, mine: true }) }, 'Back to my turn'),
    h('button', { onclick: () => post('/api/mute', { repo: pr.repo }) }, `Mute ${pr.repo}`),
    h('button', { onclick: () => post('/api/mute', { owner }) }, `Mute everything from ${owner}`),
  );
}

const reviewQuery = (pr, extra = {}) => new URLSearchParams({ repo: pr.repo, number: pr.number, ...extra }).toString();
const reviewUrl = (pr, extra = {}) => `/review?${reviewQuery(pr, extra)}`;

// A link to a PR's review. A plain click opens it in the side panel; Cmd/Ctrl/Shift/middle-click
// follow the href and open the full page instead.
function reviewLink(pr, extra, attrs, ...children) {
  const onclick = (e) => {
    markClicked(pr);
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    openReview(pr, extra);
  };
  return h('a', { ...attrs, href: reviewUrl(pr, extra), onclick }, ...children);
}

// Unresolved GitHub review threads, highlighting the ones where you owe a reply.
function threadChip(pr) {
  const t = pr.threads;
  if (!t || t.unresolved === 0) return null;
  if (t.waitingOnMe > 0) {
    return [' · ', reviewLink(pr, {}, { class: 'chip-waiting' }, `${plural(t.waitingOnMe, 'thread')} waiting on you`)];
  }
  return [' · ', h('span', null, `${plural(t.unresolved, 'open thread')}`)];
}

function prMeta(pr, showRepo) {
  const authorInSet = !!(pr.attentionSet || {})[pr.author];
  return h(
    'div',
    { class: 'meta' },
    showRepo ? `${pr.repo}#${pr.number}` : `#${pr.number}`,
    ' · by ',
    h('a', { href: `https://github.com/${pr.author}`, target: '_blank', class: authorInSet ? 'in-set' : '' }, pr.author),
    reviewerList(pr),
    threadChip(pr),
  );
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// For PRs you've reviewed: what changed since, linking to GitHub's diff of just those changes.
function sinceReviewLine(pr) {
  const s = pr.sinceReview;
  if (!s) return null;
  let text;
  if (s.rebased) text = 'Rebased or force-pushed since your review';
  else if (s.newCommits != null && s.filesChanged != null)
    text = `${plural(s.newCommits, 'new commit')}, ${plural(s.filesChanged, 'file')} changed since your review`;
  else if (s.newCommits != null) text = `${plural(s.newCommits, 'new commit')} since your review`;
  else text = 'New commits since your review';
  return h(
    'div',
    { class: 'since' },
    reviewLink(pr, { base: s.base }, {}, `${text} →`),
  );
}

function prRow(pr, showRepo) {
  const clickedAt = data.dismissedClicked[pr.url] || 0;
  const seen = clickedAt > (pr.lastEventAt || 0);
  const label = stateLabel(pr);

  const muteBtn = h('button', { class: 'icon', title: 'Mute…', 'aria-label': 'Mute' }, '⋯');
  muteBtn.onclick = (e) => {
    e.stopPropagation();
    openMenu = openMenu === pr.url ? null : pr.url;
    render();
  };

  return h(
    'li',
    { class: activeReviewUrl() === pr.url ? 'pr active' : 'pr', 'data-url': pr.url },
    h('span', { class: `dot ${pr.myStatus} ${seen ? '' : 'unseen'}`, title: seen ? 'Opened since last activity' : 'New activity' }),
    h(
      'div',
      null,
      h('div', { class: 'title' }, h('a', { href: pr.url, target: '_blank', onclick: () => markClicked(pr) }, pr.title)),
      prMeta(pr, showRepo),
      sinceReviewLine(pr),
      pr.steppedOutAt &&
        h(
          'div',
          { class: 'since muted' },
          'Not your turn until someone responds · ',
          h('button', { class: 'link-button', onclick: () => post('/api/attention', { url: pr.url, mine: true }) }, 'Undo'),
        ),
    ),
    h('div', { class: 'right' }, h('span', { class: 'muted' }, timeAgo(pr.lastEventAt)), label && h('span', { class: 'badge' }, label)),
    h(
      'div',
      { class: 'actions' },
      reviewLink(pr, {}, { class: 'icon-link', title: 'Review in Critique', 'aria-label': 'Review in Critique' }, '±'),
      h(
        'button',
        {
          class: 'icon',
          title: 'Dismiss until you restore it',
          'aria-label': 'Dismiss',
          onclick: () => post('/api/dismiss', { url: pr.url, lastEventAt: pr.lastEventAt }),
        },
        '✕',
      ),
      muteBtn,
      openMenu === pr.url && muteMenu(pr),
    ),
  );
}

function dismissedRow(pr) {
  const d = data.dismissed[pr.url] || {};
  const hasNewActivity = pr.lastEventAt && d.lastEventAt && pr.lastEventAt > d.lastEventAt;
  const seenNew = hasNewActivity && (data.dismissedClicked[pr.url] || 0) > pr.lastEventAt;
  const unseenActivity = hasNewActivity && !seenNew;

  return h(
    'li',
    { class: activeReviewUrl() === pr.url ? 'pr dismissed active' : 'pr dismissed', 'data-url': pr.url },
    h('span', { class: `dot ${unseenActivity ? 'blue unseen' : 'gray'}`, title: unseenActivity ? 'New activity since you dismissed it' : '' }),
    h(
      'div',
      null,
      h('div', { class: 'title' }, h('a', { href: pr.url, target: '_blank', onclick: () => markClicked(pr) }, pr.title)),
      prMeta(pr, true),
    ),
    h('div', { class: 'right' }, h('span', { class: 'muted' }, timeAgo(pr.lastEventAt))),
    h('div', { class: 'actions' }, h('button', { onclick: () => post('/api/restore', { url: pr.url }) }, 'Restore')),
  );
}

const byRecent = (a, b) => (b.lastEventAt || 0) - (a.lastEventAt || 0);

// Groups by role (Reviewing, Your PRs, ...); with "Group by repo" on, nests repos inside each role.
function groupedList(prs) {
  return ROLES.map(([role, title]) => {
    const group = prs.filter((p) => (p.myRole || 'other') === role).sort(byRecent);
    if (group.length === 0) return null;
    const body = groupByRepoBox.checked
      ? repoGroups(group)
      : h('ul', { class: 'prs' }, group.map((p) => prRow(p, true)));
    return [h('h3', null, `${title} (${group.length})`), body];
  });
}

// Repos ordered by their most recent activity, since prs is already sorted newest first.
function repoGroups(prs) {
  const repos = [...new Set(prs.map((p) => p.repo))];
  return repos.map((repo) => {
    const items = prs.filter((p) => p.repo === repo);
    return [
      h('h4', { class: 'repo' }, `${repo} (${items.length})`),
      h('ul', { class: 'prs' }, items.map((p) => prRow(p, false))),
    ];
  });
}

function render() {
  if (!data) return;
  const { results, dismissed } = data;

  document.title = data.needsAttention > 0 ? `(${data.needsAttention}) Critique` : 'Critique';
  setFavicon(data.needsAttention);
  document.getElementById('whoami').textContent = [
    data.username && `@${data.username}`,
    data.lastPoll && `updated ${timeAgo(data.lastPoll)}`,
  ]
    .filter(Boolean)
    .join(' · ');
  refreshBtn.disabled = data.polling;
  refreshBtn.textContent = data.polling ? 'Refreshing…' : 'Refresh';

  if (reviewPanelOpen()) panelTitle.textContent = panelTitleFor(reviewHashParams());

  const settings = onSettingsPage();
  dashboardControls.hidden = settings;
  nav.textContent = settings ? 'Back to dashboard' : 'Settings';
  nav.href = settings ? '#' : '#settings';
  if (settings) renderSettings();
  else renderDashboard(results, dismissed);
}

function renderDashboard(results, dismissed) {
  const shown = results.filter(matchesSearch);
  const active = shown.filter((pr) => !dismissed[pr.url]);
  const dismissedPRs = shown.filter((pr) => dismissed[pr.url]);
  const needs = active.filter((pr) => pr.myStatus === 'red');
  const others = active.filter((pr) => pr.myStatus !== 'red');

  const nodes = [];
  if (data.lastError) {
    const msg =
      data.lastError.type === 'auth'
        ? `GitHub token missing or rejected (${data.lastError.message}). Run \`npm run set-token\`, then refresh.`
        : `Last refresh failed: ${data.lastError.message}`;
    nodes.push(h('div', { class: 'banner' }, msg));
  }
  if (!inDesktopApp && data.settings.notifications && notificationPermission() === 'default') {
    nodes.push(
      h(
        'div',
        { class: 'banner info' },
        'Get a browser notification when a PR becomes your turn. ',
        h('button', { onclick: enableNotifications }, 'Turn on notifications'),
      ),
    );
  }

  if (!data.lastPoll && !data.lastError) {
    nodes.push(h('p', { class: 'empty' }, 'Loading your PRs…'));
  } else if (active.length === 0 && dismissedPRs.length === 0) {
    nodes.push(h('p', { class: 'empty' }, search.value ? 'No PRs match the filter.' : 'No open PRs.'));
  } else {
    // Sections flow into side-by-side columns when the window is wide enough (see .board in style.css).
    const columns = [];
    columns.push(
      h(
        'section',
        null,
        h('h2', { class: 'attention' }, `Needs your attention (${needs.length})`),
        needs.length ? groupedList(needs) : h('p', { class: 'empty' }, 'Nothing needs you right now.'),
      ),
    );
    if (others.length) {
      columns.push(h('section', null, h('h2', null, `Waiting on others (${others.length})`), groupedList(others)));
    }
    const board = (...children) => h('div', { class: `board cols-${columns.length}` }, children);
    nodes.push(board(columns));

    // Dismissed always sits below the columns, one column wide.
    if (dismissedPRs.length) {
      const details = h(
        'details',
        { open: dismissedOpen || null },
        h('summary', null, h('h2', null, `Dismissed (${dismissedPRs.length})`)),
        h('ul', { class: 'prs' }, dismissedPRs.sort(byRecent).map(dismissedRow)),
      );
      details.ontoggle = () => (dismissedOpen = details.open);
      nodes.push(h('section', { class: 'dismissed-section' }, board(details)));
    }
  }
  app.replaceChildren(...nodes);
}

// --- Settings ---

function field(label, hint, ...controls) {
  return h(
    'div',
    { class: 'field' },
    h('div', { class: 'label' }, label),
    h('div', { class: 'control' }, controls, hint && h('div', { class: 'hint' }, hint)),
  );
}

function buildSettingsForm() {
  const s = data.settings;
  const number = (name, min, max) => h('input', { type: 'number', name, min, max, value: s[name], required: true });
  const checkbox = (name, checked) => h('input', { type: 'checkbox', name, checked: checked || null });
  const radio = (name, value, checked) => h('input', { type: 'radio', name, value, checked: checked || null });
  const textarea = (name, lines, placeholder) => {
    const el = h('textarea', { name, rows: 4, placeholder });
    el.value = lines.join('\n');
    return el;
  };
  const status = h('span', { class: 'muted', role: 'status' });

  const repoMode = h(
    'select',
    { name: 'repoFilterMode' },
    [
      ['all', 'Show all repositories'],
      ['include', 'Only show these repositories'],
      ['exclude', 'Hide these repositories'],
    ].map(([value, label]) => h('option', { value, selected: s.repoFilterMode === value || null }, label)),
  );

  const testBtn = h('button', { type: 'button' }, 'Send test notification');
  testBtn.onclick = async () => {
    status.textContent = (await post('/api/test-notification')) ? 'Test notification sent.' : 'Could not send.';
  };
  const enableBtn = h('button', { type: 'button', onclick: enableNotifications }, 'Allow in this browser');

  const form = h(
    'form',
    { class: 'settings' },
    h('h2', null, 'Settings'),
    field('GitHub account', 'Stored in your macOS Keychain. To change it, run npm run set-token in the project folder.', h('span', { id: 'token-status' })),
    field('Check GitHub every', 'Between 1 and 60.', h('label', { class: 'inline' }, number('pollMinutes', 1, 60), 'minutes')),
    field(
      'Debounce',
      'How long to wait before a "Comment" review hands the turn to the author, or a push hands it back to reviewers. Gives people time to finish a batch of comments or commits. Until then a comment shows yellow for the author.',
      h('label', { class: 'inline' }, number('debounceMinutes', 0, 120), 'minutes'),
    ),
    field(
      'Pushes after review',
      'When the author pushes after a reviewer commented or requested changes, it becomes that reviewer\'s turn again, even without a re-request. Approvals are left alone.',
      h('label', { class: 'inline' }, checkbox('pushReturnsTurn', s.pushReturnsTurn), ' Hand the turn back to reviewers'),
    ),
    field(
      'Notifications',
      'Browser notifications when a PR becomes your turn. They only arrive while a Critique tab is open; clicking one opens the PR.',
      h('label', { class: 'inline' }, checkbox('notifications', s.notifications), ' Enabled'),
      h('span', { id: 'notification-permission' }),
      h('div', { class: 'inline-buttons' }, enableBtn, testBtn),
    ),
    field(
      'Team review requests',
      'Team names as shown on GitHub, one per line.',
      h('label', { class: 'inline' }, radio('teams', 'all', !s.onlyDirectRequests), ' Count requests to any of my teams'),
      h('label', { class: 'inline' }, radio('teams', 'listed', s.onlyDirectRequests), ' Only count requests to me directly, or to these teams:'),
      textarea('whitelistedTeams', s.whitelistedTeams, 'platform-team'),
    ),
    field('Repositories', 'One owner/repo per line.', repoMode, textarea('repoFilterList', s.repoFilterList, 'octocat/hello-world')),
    field('Muted', 'Mute a repo or owner from the ⋯ menu on any PR.', h('div', { id: 'muted-list' })),
    h('div', { class: 'form-actions' }, h('button', { type: 'submit', class: 'primary' }, 'Save'), status),
  );

  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const ok = await post('/api/settings', {
      pollMinutes: Number(f.get('pollMinutes')),
      debounceMinutes: Number(f.get('debounceMinutes')),
      notifications: f.get('notifications') === 'on',
      pushReturnsTurn: f.get('pushReturnsTurn') === 'on',
      onlyDirectRequests: f.get('teams') === 'listed',
      whitelistedTeams: f.get('whitelistedTeams'),
      repoFilterMode: f.get('repoFilterMode'),
      repoFilterList: f.get('repoFilterList'),
    });
    status.textContent = ok ? 'Saved. Refreshing PRs…' : 'Save failed.';
  };
  return form;
}

function renderSettings() {
  if (!settingsForm) {
    settingsForm = buildSettingsForm();
    app.replaceChildren(settingsForm);
  }

  // Live parts update on every push; the inputs are left alone.
  const permission = inDesktopApp ? 'desktop' : notificationPermission();
  const permissionText = {
    desktop: 'Shown as macOS notifications by the Critique app.',
    granted: 'Allowed in this browser.',
    default: 'Not allowed yet in this browser.',
    denied: 'Blocked in this browser. Allow notifications for localhost in your browser\'s site settings.',
    unsupported: 'This browser does not support notifications.',
  }[permission];
  const permissionEl = document.getElementById('notification-permission');
  permissionEl.className = permission === 'granted' || permission === 'desktop' ? 'muted' : 'error';
  permissionEl.textContent = permissionText;
  settingsForm.querySelector('.inline-buttons button').hidden = permission !== 'default';
  const tokenStatus = document.getElementById('token-status');
  if (data.lastError?.type === 'auth') {
    tokenStatus.className = 'error';
    tokenStatus.textContent = data.lastError.message;
  } else {
    tokenStatus.className = '';
    tokenStatus.textContent = data.username ? `Connected as @${data.username}` : 'Checking…';
  }

  const muted = [
    ...data.mutedRepos.map((repo) => ({ label: repo, body: { repo } })),
    ...data.mutedOwners.map((owner) => ({ label: `${owner} (all repos)`, body: { owner } })),
  ];
  document
    .getElementById('muted-list')
    .replaceChildren(
      ...(muted.length
        ? muted.map((m) =>
            h(
              'span',
              { class: 'chip' },
              m.label,
              h('button', { type: 'button', class: 'icon', 'aria-label': `Unmute ${m.label}`, onclick: () => post('/api/unmute', m.body) }, '✕'),
            ),
          )
        : [h('span', { class: 'muted' }, 'Nothing muted.')]),
    );
}

document.addEventListener('click', () => {
  if (openMenu) {
    openMenu = null;
    render();
  }
});

// --- Help guide + keyboard shortcuts ---

const help = document.getElementById('help');
document.getElementById('help-btn').onclick = () => help.showModal();
document.getElementById('help-close').onclick = () => help.close();
// Clicking the backdrop (outside the dialog box) closes it.
help.onclick = (e) => e.target === help && help.close();

document.addEventListener('keydown', (e) => {
  const typing = e.target.closest?.('input, textarea, select');
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'Escape' && reviewPanelOpen() && !help.open) {
    e.preventDefault();
    closeReview();
  } else if (e.key === '?') {
    e.preventDefault();
    if (help.open) help.close();
    else help.showModal();
  } else if (e.key === '/' && !help.open && !onSettingsPage()) {
    e.preventDefault();
    search.focus();
  }
});

// --- Review side panel ---
//
// The panel embeds the review page (/review?...&embed=1) in an iframe. Its state lives in the URL hash
// (#review?repo=...&number=...), so Back closes it and a reload keeps it open.

const panel = document.getElementById('review-panel');
const panelFrame = document.getElementById('review-frame');
const panelTitle = document.getElementById('review-panel-title');
const panelNewTab = document.getElementById('review-panel-newtab');
let panelSrcKey = null; // repo/number currently loaded, so in-panel navigation doesn't reload the frame
let openedFromDashboard = false;

const reviewHashParams = () => (location.hash.startsWith('#review?') ? new URLSearchParams(location.hash.slice('#review?'.length)) : null);
const reviewPanelOpen = () => !!reviewHashParams();

function activeReviewUrl() {
  const params = reviewHashParams();
  return params ? `https://github.com/${params.get('repo')}/pull/${params.get('number')}` : null;
}

function panelTitleFor(params) {
  const pr = data?.results.find((r) => r.repo === params.get('repo') && String(r.number) === params.get('number'));
  return pr ? pr.title : `${params.get('repo')}#${params.get('number')}`;
}

function openReview(pr, extra = {}) {
  openedFromDashboard = true;
  location.hash = `review?${reviewQuery(pr, extra)}`;
}

function closeReview() {
  // Undo the history entry opening the panel made, so Back doesn't reopen it.
  if (openedFromDashboard) {
    openedFromDashboard = false;
    history.back();
  } else {
    history.replaceState(null, '', location.pathname + location.search);
    syncReviewPanel();
  }
}

function syncReviewPanel() {
  const params = reviewHashParams();
  document.body.classList.toggle('panel-open', !!params);
  panel.hidden = !params;
  if (!params) {
    panelSrcKey = null;
    loadPanelFrame('about:blank');
    highlightActiveRow(null);
    return;
  }
  const query = params.toString();
  const key = `${params.get('repo')}#${params.get('number')}`;
  panelNewTab.href = `/review?${query}`;
  document.getElementById('review-panel-github').href = activeReviewUrl();
  if (key !== panelSrcKey) {
    panelSrcKey = key;
    loadPanelFrame(`/review?${query}&embed=1`);
    panelFrame.focus();
  }
  panelTitle.textContent = panelTitleFor(params);
  highlightActiveRow(activeReviewUrl());
}

// Swap the frame's page without adding a history entry; otherwise Back would step the frame
// instead of closing the panel.
function loadPanelFrame(url) {
  panelFrame.contentWindow.location.replace(url);
}

function highlightActiveRow(url) {
  for (const li of document.querySelectorAll('.pr.active')) li.classList.remove('active');
  if (url) document.querySelector(`.pr[data-url="${CSS.escape(url)}"]`)?.classList.add('active');
}

document.getElementById('review-panel-close').onclick = closeReview;

// The embedded page reports version changes (to keep the hash current) and asks to close on Esc.
window.addEventListener('message', (e) => {
  if (e.origin !== location.origin || e.source !== panelFrame.contentWindow) return;
  if (e.data?.type === 'critique:close') closeReview();
  if (e.data?.type === 'critique:navigate' && reviewPanelOpen()) {
    history.replaceState(null, '', `#review?${e.data.query}`);
    panelNewTab.href = `/review?${e.data.query}`;
  }
});

// Drag the panel's left edge to resize it; the width is remembered.
const PANEL_MIN = 480;
const DASHBOARD_MIN = 420;
function setPanelWidth(px) {
  const width = Math.max(PANEL_MIN, Math.min(px, window.innerWidth - DASHBOARD_MIN));
  document.documentElement.style.setProperty('--panel-width', `${width}px`);
  return width;
}
const savedPanelWidth = () => pref('panelWidth', null);
if (savedPanelWidth()) setPanelWidth(savedPanelWidth());
// Re-clamp a remembered width when the window shrinks, so the dashboard keeps its minimum.
window.addEventListener('resize', () => savedPanelWidth() && setPanelWidth(savedPanelWidth()));

document.getElementById('review-panel-resize').onpointerdown = (e) => {
  e.preventDefault();
  const handle = e.currentTarget;
  handle.setPointerCapture(e.pointerId);
  document.body.classList.add('resizing'); // the iframe would otherwise swallow pointer events
  handle.onpointermove = (ev) => setPanelWidth(window.innerWidth - ev.clientX);
  handle.onpointerup = (ev) => {
    handle.onpointermove = handle.onpointerup = null;
    document.body.classList.remove('resizing');
    setPref('panelWidth', setPanelWidth(window.innerWidth - ev.clientX));
  };
};

syncReviewPanel();

// --- Theme ---

document.getElementById('theme-slot').replaceWith(themeToggle());
// The review panel's frame also listens for storage events; this covers browsers where storage is blocked.
onThemeChange((theme) => panelFrame.contentWindow?.postMessage({ type: 'critique:theme', theme }, location.origin));
