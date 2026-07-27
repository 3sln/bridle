# Self-hosted icon font

`material-symbols-rounded.woff2` is a **subset** of Google's
[Material Symbols Rounded](https://fonts.google.com/icons) containing only the
glyphs bridle actually renders (see `src/ui/icon.js` for the list). Licensed
under the Apache License 2.0, like the upstream font.

It is self-hosted deliberately. bridle is built for a phone with a bad
connection — a car, a basement, a plane — and an icon font fetched from
`fonts.googleapis.com` is a third-party request on the critical path: when it
fails, every glyph falls back to its ligature *name* ("volume_up",
"add_photo_alternate") and the layout comes apart. It is also the only
third-party request the app would otherwise make, in an app whose whole pitch is
that nothing leaves your devices.

To regenerate after adding an icon, list every glyph name used and ask Google
Fonts for that subset:

```sh
ICONS=add,add_comment,…            # comma-separated, matching src/ui/icon.js
CSS="https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200&icon_names=$ICONS&display=block"
curl -sS -A "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36" "$CSS" \
  | grep -o 'url(\(.*\)) format' | sed 's/^url(//; s/) format$//' \
  | xargs curl -sS -A "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36" -o material-symbols-rounded.woff2
```

The `-A` matters: Google Fonts serves an older format to unrecognized clients.
