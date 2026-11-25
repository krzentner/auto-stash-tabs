# Auto Stash Tabs

A Firefox extension that automatically "stashes" idle tabs to bookmarks:
when a tab has been idle for more than a configurable amount of time *and*
more than a configurable number of tabs are open, the tab is bookmarked and
closed.

It combines the core behavior of
[Tab Wrangler](https://github.com/tabwrangler/tabwrangler) (auto-close idle
tabs, but never drop below a minimum tab count) with the storage format of
[Tab Stash](https://github.com/josh-berry/tab-stash): stashed tabs are saved
as bookmarks under the same `Tab Stash` folder, in `saved-<timestamp>` groups
that the Tab Stash extension recognizes and displays natively. If you also
have Tab Stash installed, auto-stashed tabs show up in its stash list just
like manually stashed ones, and you can restore, rename, or organize them
from there.

Both upstream projects are included as git submodules under `vendor/` for
reference (they are not needed at runtime).

## How it works

Every minute, the extension checks all normal (non-private) windows:

1. A window (or the whole browser, configurable) must have **more than N
   tabs** open; tabs are only stashed down to N, never below.
2. Among eligible tabs, those **idle longer than the threshold** are stashed,
   least recently used first. Idle time uses Firefox's native
   `tab.lastAccessed`; a browser restart resets every tab's timer (same
   grace behavior as Tab Wrangler).
3. Each stashed tab is bookmarked into the current `saved-…` group under the
   `Tab Stash` folder (a recent group is reused, otherwise a new one is
   created at the top, exactly as Tab Stash does), and then closed. The tab
   is only closed after the bookmark has been created.

Never stashed: the active tab, multi-selected tabs, pinned tabs (optional),
tabs playing sound (optional), hidden tabs, tabs requesting attention or
sharing camera/microphone/screen, private-browsing tabs, whitelisted URLs,
tabs locked via the toolbar popup, and non-web URLs (`about:`, extension
pages, etc.). Reader-view tabs are stashed as their underlying article URL.

## Options

- **Idle minutes** (default 20) — how long a tab must be inactive.
- **Minimum tabs** (default 10) — only stash while more tabs than this are
  open; counted per window or across all windows.
- **Apply the cap across all tab groups** (default on) — grouped tabs count
  toward their window's total. When off, each Firefox tab group is capped
  separately (it keeps its own most recently used tabs down to the minimum),
  and ungrouped tabs are counted per window as usual. Collapsed groups are
  swept like expanded ones — Firefox collapses them only visually. A tab
  stashed out of a group is bookmarked into a subfolder named after the group
  (the same layout Tab Stash 3.5+ uses), so Tab Stash can restore it as a tab
  group. This needs Firefox 139+; older versions stash grouped tabs flat.
- **Skip pinned / audible tabs** (default on).
- **Whitelist** — one pattern per line; a tab is kept if its URL contains the
  pattern (case insensitive, `*` wildcard supported).
- **Group window** (default 60 min) — reuse the most recent unnamed stash
  group if it is newer than this, otherwise start a new group.
- **Deduplicate** (default on) — if a URL is already saved anywhere in the
  stash, don't create a second bookmark (the tab is still closed).

The toolbar popup shows which tabs will be stashed next, lets you pause the
extension, lock the current tab, or trigger an immediate "stash idle tabs
now" sweep.

## Development

```sh
git clone --recurse-submodules <this repo>
```

Run in a temporary Firefox profile with
[web-ext](https://extensionworkshop.com/documentation/develop/getting-started-with-web-ext/):

```sh
web-ext run
```

Or load manually: open `about:debugging#/runtime/this-firefox` →
*Load Temporary Add-on…* → select `manifest.json`.

To build an XPI: `web-ext build` (submodules under `vendor/` are excluded via
`.web-ext-config.mjs` if you add one, or just zip the top-level files).

### Layout

| Path            | Purpose                                             |
| --------------- | --------------------------------------------------- |
| `manifest.json` | MV2 manifest (permissions: tabs, tabGroups, bookmarks, storage, alarms) |
| `background.js` | Idle tracking, sweep loop, Tab Stash-compatible bookmark writing |
| `common.js`     | Shared settings defaults and helpers                 |
| `options.*`     | Settings page                                        |
| `popup.*`       | Toolbar popup (pause, lock tab, stash now, upcoming list) |
| `vendor/`       | Upstream projects as submodules, for reference only  |
