// Made-up PRs for the demo: a fictional "acme" org where you are "jordan". Times are relative to
// when the demo starts. Every PR has the fields the GitHub search, pulls and timeline APIs return
// (only the ones Critique reads), and acme/web#1290 also has file contents, review threads and a
// conversation so the review page has something to show.

import { createHash } from 'node:crypto';

export const ME = 'jordan';

export const sha = (name) => createHash('sha1').update(name).digest('hex');
const ago = (now, { m = 0, h = 0, d = 0 }) => new Date(now - ((d * 24 + h) * 60 + m) * 60_000).toISOString();
const user = (login) => ({ login, type: 'User' });

// --- acme/web#1290: the PR shown on the review page ---

const SETTINGS_PAGE_BASE = `import { useState } from 'react';
import { saveSettings } from '../api/settings';
import { NotificationPrefs } from './NotificationPrefs';

export function SettingsPage({ initial }) {
  const [name, setName] = useState(initial.name);
  const [email, setEmail] = useState(initial.email);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    await saveSettings({ name, email });
    setSaving(false);
  }

  return (
    <div className="settings">
      <h1>Settings</h1>
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        Email
        <input value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <NotificationPrefs />
      <button disabled={saving} onClick={save}>
        {saving ? 'Saving…' : 'Save'}
      </button>
    </div>
  );
}
`;

const SETTINGS_PAGE_REVIEWED = `import { useState } from 'react';
import { saveSettings } from '../api/settings';
import { Form, TextField } from '../components/form';
import { NotificationPrefs } from './NotificationPrefs';

export function SettingsPage({ initial }) {
  const [values, setValues] = useState(initial);

  function update(field, value) {
    const next = { ...values, [field]: value };
    setValues(next);
    saveSettings(next);
  }

  return (
    <Form title="Settings">
      <TextField label="Name" value={values.name} onChange={(v) => update('name', v)} />
      <TextField label="Email" type="email" value={values.email} onChange={(v) => update('email', v)} />
      <NotificationPrefs values={values} onChange={update} />
    </Form>
  );
}
`;

const SETTINGS_PAGE_HEAD = `import { useState } from 'react';
import { saveSettings } from '../api/settings';
import { Form, TextField } from '../components/form';
import { NotificationPrefs } from './NotificationPrefs';

export function SettingsPage({ initial }) {
  const [values, setValues] = useState(initial);
  const [status, setStatus] = useState('idle');

  function update(field, value) {
    setValues((prev) => ({ ...prev, [field]: value }));
  }

  async function save() {
    setStatus('saving');
    try {
      await saveSettings(values);
      setStatus('saved');
    } catch {
      setStatus('error');
    }
  }

  return (
    <Form title="Settings" status={status}>
      <TextField label="Name" value={values.name} onChange={(v) => update('name', v)} onBlur={save} />
      <TextField label="Email" type="email" value={values.email} onChange={(v) => update('email', v)} onBlur={save} />
      <NotificationPrefs values={values} onChange={update} onBlur={save} />
    </Form>
  );
}
`;

const PREFS_BASE = `export function NotificationPrefs() {
  return (
    <fieldset>
      <legend>Notifications</legend>
      <label>
        <input type="checkbox" name="digest" />
        <span>Weekly digest</span>
      </label>
      <label>
        <input type="checkbox" name="mentions" />
        <span>Mentions</span>
      </label>
    </fieldset>
  );
}
`;

const PREFS_REVIEWED = `import { Toggle } from '../components/form';

export function NotificationPrefs({ values, onChange }) {
  return (
    <fieldset>
      <legend>Notifications</legend>
      <Toggle label="Weekly digest" checked={values.digest} onChange={(v) => onChange('digest', v)}>
        <span>Weekly digest</span>
      </Toggle>
      <Toggle label="Mentions" checked={values.mentions} onChange={(v) => onChange('mentions', v)}>
        <span>Mentions</span>
      </Toggle>
    </fieldset>
  );
}
`;

const PREFS_HEAD = `import { Toggle } from '../components/form';

export function NotificationPrefs({ values, onChange, onBlur }) {
  return (
    <fieldset>
      <legend>Notifications</legend>
      <Toggle label="Weekly digest" checked={values.digest} onChange={(v) => onChange('digest', v)} onBlur={onBlur} />
      <Toggle label="Mentions" checked={values.mentions} onChange={(v) => onChange('mentions', v)} onBlur={onBlur} />
    </fieldset>
  );
}
`;

const TOGGLE = `export function Toggle({ label, checked, onChange, onBlur }) {
  return (
    <label className="toggle">
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        onBlur={onBlur}
      />
      <span className="toggle-label">{label}</span>
    </label>
  );
}
`;

const FORM_INDEX_BASE = `export { Form } from './Form';
export { TextField } from './TextField';
`;
const FORM_INDEX_HEAD = `export { Form } from './Form';
export { TextField } from './TextField';
export { Toggle } from './Toggle';
`;

const TEST_REVIEWED = `import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsPage } from './SettingsPage';

const initial = { name: 'Jordan', email: 'jordan@example.com', digest: true, mentions: false };

test('shows the current settings', () => {
  render(<SettingsPage initial={initial} />);
  expect(screen.getByLabelText('Name')).toHaveValue('Jordan');
});
`;

const TEST_HEAD = `import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { saveSettings } from '../api/settings';
import { SettingsPage } from './SettingsPage';

vi.mock('../api/settings');

const initial = { name: 'Jordan', email: 'jordan@example.com', digest: true, mentions: false };

test('shows the current settings', () => {
  render(<SettingsPage initial={initial} />);
  expect(screen.getByLabelText('Name')).toHaveValue('Jordan');
});

test('saves when a field loses focus, not on every keystroke', async () => {
  render(<SettingsPage initial={initial} />);
  await userEvent.type(screen.getByLabelText('Name'), ' Lee');
  expect(saveSettings).not.toHaveBeenCalled();
  await userEvent.tab();
  expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({ name: 'Jordan Lee' }));
});
`;

const SCHEMA_BASE = `// Generated by api-codegen. Do not edit.
export interface Settings {
  name: string;
  email: string;
}
`;
const SCHEMA_HEAD = `// Generated by api-codegen. Do not edit.
export interface Settings {
  name: string;
  email: string;
  digest: boolean;
  mentions: boolean;
}

export interface SaveSettingsResponse {
  settings: Settings;
  savedAt: string;
}
`;

const GITATTRIBUTES = `src/api/generated/** linguist-generated
`;

const webBase = {
  '.gitattributes': GITATTRIBUTES,
  'src/settings/SettingsPage.tsx': SETTINGS_PAGE_BASE,
  'src/settings/NotificationPrefs.tsx': PREFS_BASE,
  'src/components/form/index.ts': FORM_INDEX_BASE,
  'src/api/generated/schema.ts': SCHEMA_BASE,
};
const webReviewed = {
  ...webBase,
  'src/settings/SettingsPage.tsx': SETTINGS_PAGE_REVIEWED,
  'src/settings/NotificationPrefs.tsx': PREFS_REVIEWED,
  'src/components/form/Toggle.tsx': TOGGLE.replace(', onBlur', '').replace('\n        onBlur={onBlur}', ''),
  'src/components/form/index.ts': FORM_INDEX_HEAD,
  'src/settings/SettingsPage.test.tsx': TEST_REVIEWED,
  'src/api/generated/schema.ts': SCHEMA_HEAD,
};
const webHead = {
  ...webReviewed,
  'src/settings/SettingsPage.tsx': SETTINGS_PAGE_HEAD,
  'src/settings/NotificationPrefs.tsx': PREFS_HEAD,
  'src/components/form/Toggle.tsx': TOGGLE,
  'src/settings/SettingsPage.test.tsx': TEST_HEAD,
};

const lineOf = (text, needle) => text.split('\n').findIndex((l) => l.includes(needle)) + 1;

function settingsPr(now) {
  const commits = [
    { name: 'web-1290-c1', message: 'Move the settings page onto Form and TextField', at: ago(now, { d: 2, h: 3 }), files: webReviewed },
    { name: 'web-1290-c2', message: 'Use Toggle for notification preferences', at: ago(now, { d: 2, h: 1 }), files: webReviewed },
    { name: 'web-1290-c3', message: 'Save settings on blur instead of on every change', at: ago(now, { h: 3 }), files: webHead },
    { name: 'web-1290-c4', message: 'Drop the extra label spans from Toggle', at: ago(now, { h: 2, m: 40 }), files: webHead },
  ].map((c) => ({ ...c, sha: sha(c.name) }));
  const reviewed = commits[1].sha;
  const head = commits[3].sha;
  const pagePath = 'src/settings/SettingsPage.tsx';
  const prefsPath = 'src/settings/NotificationPrefs.tsx';

  return {
    repo: 'acme/web',
    number: 1290,
    title: 'Migrate the settings page to the new form components',
    author: 'sam',
    base: { sha: sha('web-main'), files: webBase },
    commits,
    timeline: [
      { event: 'review_requested', actor: user('sam'), requested_reviewer: user(ME), created_at: ago(now, { d: 2 }) },
      { event: 'review_requested', actor: user('sam'), requested_reviewer: user('priya'), created_at: ago(now, { d: 2 }) },
      ...commits.slice(0, 2).map((c) => ({ event: 'committed', sha: c.sha, message: c.message, committer: { date: c.at } })),
      { event: 'reviewed', user: user(ME), state: 'changes_requested', commit_id: reviewed, submitted_at: ago(now, { d: 1, h: 4 }) },
      { event: 'reviewed', user: user('priya'), state: 'commented', commit_id: reviewed, submitted_at: ago(now, { d: 1, h: 2 }) },
      ...commits.slice(2).map((c) => ({ event: 'committed', sha: c.sha, message: c.message, committer: { date: c.at } })),
      { event: 'commented', actor: user('sam'), body: 'Thanks for the reviews! Both are addressed in the last two commits.', created_at: ago(now, { h: 2, m: 35 }) },
    ],
    threads: [
      {
        path: pagePath,
        line: lineOf(SETTINGS_PAGE_HEAD, 'label="Name"'),
        anchorText: SETTINGS_PAGE_REVIEWED,
        anchorLine: lineOf(SETTINGS_PAGE_REVIEWED, 'saveSettings(next)'),
        originalCommit: reviewed,
        isResolved: false,
        comments: [
          { author: ME, body: 'This saves on every keystroke. Can we save on blur instead, or debounce it?', at: ago(now, { d: 1, h: 4 }) },
          { author: 'sam', body: 'Switched to saving on blur, with a status the form can show. Added a test for it too.', at: ago(now, { h: 2, m: 50 }) },
        ],
      },
      {
        path: prefsPath,
        line: lineOf(PREFS_HEAD, 'label="Weekly digest"'),
        anchorText: PREFS_REVIEWED,
        anchorLine: lineOf(PREFS_REVIEWED, '<span>Weekly digest</span>'),
        originalCommit: reviewed,
        isResolved: true,
        comments: [
          { author: ME, body: 'Nit: <code>Toggle</code> already renders the label, so these spans can go.', at: ago(now, { d: 1, h: 4 }) },
          { author: 'sam', body: 'Done.', at: ago(now, { h: 2, m: 40 }) },
        ],
      },
      {
        path: 'src/components/form/Toggle.tsx',
        line: lineOf(TOGGLE, 'role="switch"'),
        anchorText: TOGGLE,
        anchorLine: lineOf(TOGGLE, 'role="switch"'),
        originalCommit: reviewed,
        isResolved: false,
        comments: [{ author: 'priya', body: 'Should this forward a ref, so forms can focus it when validation fails?', at: ago(now, { d: 1, h: 2 }) }],
      },
    ],
    conversation: {
      createdAt: ago(now, { d: 2, h: 4 }),
      bodyHTML:
        '<p>Moves the settings page onto the shared <code>Form</code>, <code>TextField</code> and new <code>Toggle</code> components, so it matches the rest of the app and gets validation and focus handling for free.</p><ul><li>Adds <code>Toggle</code> to the form components</li><li>Regenerates the API schema for the new notification fields</li></ul>',
      items: [
        ...commits.slice(0, 2).map((c) => ({ __typename: 'PullRequestCommit', commit: { oid: c.sha, messageHeadline: c.message, committedDate: c.at, author: { user: { login: 'sam' } } } })),
        { __typename: 'ReviewRequestedEvent', actor: { login: 'sam' }, createdAt: ago(now, { d: 2 }), requestedReviewer: { login: ME } },
        { __typename: 'ReviewRequestedEvent', actor: { login: 'sam' }, createdAt: ago(now, { d: 2 }), requestedReviewer: { login: 'priya' } },
        { __typename: 'PullRequestReview', id: 'review-jordan', author: { login: ME }, state: 'CHANGES_REQUESTED', submittedAt: ago(now, { d: 1, h: 4 }), bodyHTML: '<p>Looks great overall. One behavior change to sort out before this goes in.</p>', url: '#', commit: { oid: reviewed }, comments: { totalCount: 2 } },
        { __typename: 'PullRequestReview', id: 'review-priya', author: { login: 'priya' }, state: 'COMMENTED', submittedAt: ago(now, { d: 1, h: 2 }), bodyHTML: '', url: '#', commit: { oid: reviewed }, comments: { totalCount: 1 } },
        ...commits.slice(2).map((c) => ({ __typename: 'PullRequestCommit', commit: { oid: c.sha, messageHeadline: c.message, committedDate: c.at, author: { user: { login: 'sam' } } } })),
        { __typename: 'IssueComment', author: { login: 'sam' }, createdAt: ago(now, { h: 2, m: 35 }), bodyHTML: '<p>Thanks for the reviews! Both are addressed in the last two commits.</p>', url: '#' },
      ],
    },
    head,
  };
}

// --- Everything else: just enough timeline for the attention set ---

function simplePr(repo, number, title, author, timeline, { draft = false, head = `${repo}#${number}` } = {}) {
  // The PR's commit, shortly before its first event, so its age comes from the timeline.
  const opened = new Date(new Date(timeline[0].created_at).getTime() - 10 * 60_000).toISOString();
  const commit = { event: 'committed', sha: sha(head), message: title, committer: { date: opened } };
  return { repo, number, title, author, draft, timeline: [commit, ...timeline], head: sha(head), base: { sha: sha(`${repo}-main`), files: {} }, commits: [], threads: [] };
}

export function scenario(now = Date.now()) {
  const requested = (actor, reviewer, at) => ({ event: 'review_requested', actor: user(actor), requested_reviewer: user(reviewer), created_at: at });
  const review = (who, state, head, at) => ({ event: 'reviewed', user: user(who), state, commit_id: sha(head), submitted_at: at });

  const prs = [
    settingsPr(now),
    simplePr('acme/api', 482, 'Add rate limiting to the public API', 'priya', [requested('priya', ME, ago(now, { h: 3 }))]),
    simplePr('acme/web', 1301, 'Fix the flaky checkout test', ME, [
      requested(ME, 'sam', ago(now, { h: 5 })),
      review('sam', 'changes_requested', 'acme/web#1301', ago(now, { m: 40 })),
    ]),
    simplePr('acme/design-system', 77, 'Button: add a loading state', 'lee', [
      requested('lee', ME, ago(now, { d: 3 })),
      review(ME, 'commented', 'ds-77-old', ago(now, { d: 2 })),
      requested('lee', ME, ago(now, { h: 1 })),
    ]),
    simplePr('acme/api', 475, 'Upgrade to Node 24', ME, [
      requested(ME, 'priya', ago(now, { d: 1 })),
      review('priya', 'approved', 'acme/api#475', ago(now, { h: 6 })),
    ]),
    simplePr('acme/web', 1295, 'Add dark mode to the billing page', 'lee', [
      requested('lee', ME, ago(now, { h: 26 })),
      requested('lee', 'sam', ago(now, { h: 26 })),
    ]),
    simplePr('acme/api', 488, 'Cache feature flag lookups', ME, [
      requested(ME, 'priya', ago(now, { h: 2 })),
      requested(ME, 'sam', ago(now, { h: 2 })),
    ]),
    simplePr('acme/web', 1288, 'Keyboard shortcuts for the command palette', 'sam', [
      requested('sam', ME, ago(now, { d: 1, h: 6 })),
      review(ME, 'approved', 'acme/web#1288', ago(now, { h: 20 })),
    ]),
    simplePr('acme/infra', 312, 'Rotate the staging TLS certificates', 'priya', [
      requested('priya', ME, ago(now, { h: 4 })),
      review(ME, 'commented', 'acme/infra#312', ago(now, { m: 5 })),
    ]),
    simplePr('acme/design-system', 80, 'Tokens: add an elevation scale', ME, [{ event: 'convert_to_draft', actor: user(ME), created_at: ago(now, { d: 1 }) }], {
      draft: true,
    }),
  ];

  // Threads on #1301 (your PR): sam is waiting on your reply.
  prs[2].threads = [
    {
      path: 'e2e/checkout.spec.ts',
      line: 12,
      isResolved: false,
      comments: [{ author: 'sam', body: 'Waiting on the network idle event here hides the real race. Can we wait for the order summary instead?', at: ago(now, { m: 40 }) }],
    },
  ];
  return prs;
}
