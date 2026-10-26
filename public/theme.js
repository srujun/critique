// Light/dark theme, shared by the dashboard and the review page (which imports this into its bundle).
// 'system' follows the OS setting. Stored per browser; a tiny inline script in each page's <head>
// applies it before first paint so there's no flash of the wrong theme.

const KEY = 'critique.theme';
const ORDER = ['system', 'light', 'dark'];
const LABELS = { system: 'System', light: 'Light', dark: 'Dark' };
const ICONS = { system: '◐', light: '☀', dark: '☾' };
const listeners = new Set();

export function getTheme() {
  try {
    const theme = JSON.parse(localStorage.getItem(KEY));
    return ORDER.includes(theme) ? theme : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(theme) {
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  for (const fn of listeners) fn(theme);
}

export function setTheme(theme) {
  try {
    localStorage.setItem(KEY, JSON.stringify(theme));
  } catch {
    // storage unavailable; the choice lasts until the page reloads
  }
  applyTheme(theme);
}

export function onThemeChange(fn) {
  listeners.add(fn);
}

// Other Critique tabs and frames pick up changes through the storage event.
window.addEventListener('storage', (e) => {
  if (e.key === KEY) applyTheme(getTheme());
});

/** A header button that cycles System → Light → Dark. */
export function themeToggle() {
  const button = document.createElement('button');
  const update = (theme) => {
    button.textContent = ICONS[theme];
    button.title = `Theme: ${LABELS[theme]} (click to change)`;
    button.setAttribute('aria-label', `Theme: ${LABELS[theme]}`);
  };
  button.className = 'theme-toggle';
  button.onclick = () => setTheme(ORDER[(ORDER.indexOf(getTheme()) + 1) % ORDER.length]);
  update(getTheme());
  onThemeChange(update);
  return button;
}
