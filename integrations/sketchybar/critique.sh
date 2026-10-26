#!/usr/bin/env bash
# SketchyBar item for Critique: shows how many PRs need you, and clicking it opens Critique's
# menu bar menu right under the bar. Right-click opens the dashboard.
#
# The Critique app sends a critique_update event (with COUNT and STATE) whenever the count changes;
# on any other event this asks the local server directly.

PORT="${CRITIQUE_PORT:-7878}"
ICON_COLOR_OK=0xff9ece6a      # nothing needs you
ICON_COLOR_NEEDS=0xfff7768e   # something does
ICON_COLOR_OFF=0xff565f89     # Critique isn't running, or the last refresh failed

if [ "$SENDER" = "mouse.clicked" ]; then
  if [ "$BUTTON" = "right" ]; then
    open -g "critique://open"
  else
    TOP=$(sketchybar --query bar 2>/dev/null | /usr/bin/plutil -extract height raw - 2>/dev/null)
    open -g "critique://menu${TOP:+?top=$TOP}"
  fi
  exit 0
fi

if [ "$SENDER" != "critique_update" ]; then
  DATA=$(curl -sf --max-time 2 "http://127.0.0.1:$PORT/api/data")
  if [ -z "$DATA" ]; then
    STATE=off
  else
    COUNT=$(printf '%s' "$DATA" | grep -o '"needsAttention":[0-9]*' | head -1 | cut -d: -f2)
    if printf '%s' "$DATA" | grep -q '"lastError":{'; then STATE=error; else STATE=ok; fi
  fi
fi

case "$STATE" in
  ok)
    if [ "${COUNT:-0}" -gt 0 ]; then
      sketchybar --set "$NAME" icon.color=$ICON_COLOR_NEEDS label="$COUNT" label.drawing=on
    else
      sketchybar --set "$NAME" icon.color=$ICON_COLOR_OK label.drawing=off
    fi
    ;;
  error) sketchybar --set "$NAME" icon.color=$ICON_COLOR_OFF label="!" label.drawing=on ;;
  *) sketchybar --set "$NAME" icon.color=$ICON_COLOR_OFF label.drawing=off ;;
esac
