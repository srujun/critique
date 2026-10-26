# SketchyBar

Shows how many PRs need you in [SketchyBar](https://github.com/FelixKratz/SketchyBar). Click it for the same menu as Critique's menu bar icon, opened right under the bar. Right-click opens the dashboard.

It needs the Critique desktop app (`npm run app`), which handles the `critique://menu` link and tells SketchyBar when the count changes.

## Setup

Copy the plugin into your SketchyBar plugins folder:

```sh
cp integrations/sketchybar/critique.sh ~/.config/sketchybar/plugins/
```

Then add the item to `~/.config/sketchybar/sketchybarrc` (the icon is the Nerd Font `nf-oct-code_review` glyph):

```sh
sketchybar --add event critique_update \
           --add item critique right \
           --set critique icon= update_freq=120 script="$PLUGIN_DIR/critique.sh" \
           --subscribe critique critique_update mouse.clicked system_woke
```

Reload with `sketchybar --reload`. If Critique runs on a port other than 7878, set `CRITIQUE_PORT` in the script's environment.
