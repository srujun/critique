# Critique

A local, Google Critique-style "attention set" dashboard for GitHub PRs. It shows whose turn it is on every open PR you're involved in and sends a desktop notification when one becomes your turn.

## Run

```bash
npm install     # the server has no runtime deps; @pierre/diffs is bundled into the review page
npm run set-token   # once
npm start           # or `npm run open` to also open the browser
```

Then open http://localhost:7878.

Auth uses a fine-grained GitHub personal access token with read-only access to the repositories you review: **Pull requests: Read** and **Contents: Read** (for diffs and `.gitattributes`). Critique never writes to GitHub. The token is stored in your macOS login Keychain. Store or replace it with `npm run set-token`, which prompts for the token so it never lands in shell history. The server reads it from Keychain on each poll, so a rotated token takes effect without a restart. To remove it: `security delete-generic-password -s critique-github-pat`.

Notifications are browser notifications, shown by any open Critique tab, so keep one open (a pinned tab works well). Allow them from the banner on first visit or from Settings.

Change settings from the Settings page in the dashboard. They apply immediately and are saved to `~/.config/critique/config.json`. The port is the only setting that has to be edited in that file, and it needs a restart.

## Desktop app

```bash
npm run app        # builds dist/mac-arm64/Critique.app
open dist/mac-arm64/Critique.app   # or copy it into /Applications
```

The app runs the server itself (or uses one already running on the same port), puts your count in the menu bar with a native menu of PRs that need you, and sends macOS notifications. Closing the window keeps it running in the menu bar; turn on **Launch at Login** from that menu. It's signed locally (ad hoc), so it opens on the Mac that built it without an Apple developer account. `npm run app:dev` runs it without packaging.

Using [SketchyBar](https://github.com/FelixKratz/SketchyBar)? See [integrations/sketchybar](integrations/sketchybar) for an item that shows the count and opens the same menu.

## Layout

- `lib/attention.js`: turn rules (who's in the attention set and why). Pure function.
- `lib/poller.js`: GitHub fetching, filtering, and notification decisions.
- `server.js`: polling loop, JSON/SSE API on 127.0.0.1; decides when to notify and pushes it to open tabs.
- `lib/review.js`, `lib/threads.js`: diffs between PR versions and comment threads for the review page.
- `desktop/`: the Electron app (menu bar item, native menu and notifications, app window). `lib/menu-model.js` decides what the menu shows.
- `public/`: the dashboard and review page. `client/review.js` is the review page's source; `npm run build` bundles it (with [@pierre/diffs](https://diffs.com)) into `public/build`, and `npm start` builds first.

## Credit

`lib/attention.js` and `tests/attention.test.js` come from [justinchuby/github-attention-set](https://github.com/justinchuby/github-attention-set) at commit 4d4fa34 (MIT, per that project's README). The rest is a rewrite of the extension's background worker and popup for a local server.

## License

MIT. See [LICENSE](LICENSE).
