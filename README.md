# Critique

A macOS menu bar app that brings Google Critique's "attention set" to GitHub PRs. It tracks whose turn it is on every open PR you're involved in, shows how many need you in the menu bar, and notifies you when one becomes your turn.

- **Menu bar:** your count, plus a native menu of the PRs that need you, each with why and what you can do (review, open on GitHub, not my turn, dismiss, mute).
- **Dashboard:** every PR you're involved in, grouped by whose turn it is, including what changed since your last review.
- **Review page:** the PR's diff (the whole PR, changes since your review, or any two versions) with GitHub's comment threads inline and its conversation timeline.

## Install

Critique isn't distributed as a download yet, so build it from source (needs Node 22+):

```bash
npm install
npm run set-token   # store your GitHub token in the macOS Keychain
npm run app         # builds dist/mac-arm64/Critique.app
mv dist/mac-arm64/Critique.app /Applications/
open /Applications/Critique.app
```

The app is signed locally (ad hoc), so it opens on the Mac that built it without an Apple developer account. Closing its window keeps it running in the menu bar. Turn on **Launch at Login** from the menu.

### GitHub token

Critique uses a fine-grained personal access token with read-only access to the repositories you review: **Pull requests: Read** and **Contents: Read** (for diffs and `.gitattributes`). It never writes to GitHub.

`npm run set-token` prompts for the token so it never lands in shell history and stores it in your login Keychain. Run it again to replace the token; the new one is picked up on the next refresh. To remove it: `security delete-generic-password -s critique-github-pat`.

### Settings

Change settings from the Settings page in the app. They're saved to `~/.config/critique/config.json`, along with Critique's state. The port (default 7878) is the only setting edited in that file directly, and it needs a restart.

### SketchyBar

Using [SketchyBar](https://github.com/FelixKratz/SketchyBar)? See [integrations/sketchybar](integrations/sketchybar) for an item that shows the count and opens the same menu.

## Local development

The app is a local web server plus an Electron shell. To work on the server and pages without packaging:

```bash
npm start           # builds the review page bundle and serves http://localhost:7878
npm run open        # same, and opens it in your browser
npm run app:dev     # runs the desktop app without packaging
npm test
```

In a browser tab, notifications are browser notifications, shown while a Critique tab is open. The desktop app uses a server already running on the same port if there is one, so you can keep `npm start` running while you use it.

### Layout

- `lib/attention.js`: turn rules (who's in the attention set and why). Pure function.
- `lib/poller.js`: GitHub fetching, filtering, and notification decisions.
- `server.js`: polling loop and the JSON/SSE API on 127.0.0.1; decides when to notify.
- `lib/review.js`, `lib/threads.js`: diffs between PR versions and comment threads for the review page.
- `desktop/`: the Electron app (menu bar item, native menu and notifications, app window). `lib/menu-model.js` decides what the menu shows.
- `public/`: the dashboard and review page. `client/review.js` is the review page's source; `npm run build` bundles it with [@pierre/diffs](https://diffs.com) into `public/build`.

## Credit

Critique started from [justinchuby/github-attention-set](https://github.com/justinchuby/github-attention-set), a Chrome extension that brings the attention set to GitHub. Its turn rules live on in `lib/attention.js`. Diffs are rendered with [@pierre/diffs](https://diffs.com).

## License

MIT. See [LICENSE](LICENSE).
