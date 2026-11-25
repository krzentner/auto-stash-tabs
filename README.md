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

There is no periodic timer. The extension checks all normal (non-private)
windows whenever a tab is opened or activated (or a setting or exemption
changes), and otherwise sets a one-shot alarm for the moment the next tab
becomes idle enough to stash — at most once a minute, and not at all while
nothing can be stashed. On each check:

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
pages, etc.). Hidden and private-browsing tabs also don't count toward the
minimum tab count. Reader-view tabs are stashed as their underlying article URL.

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
  group.
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

## Zen Browser

Zen only tells extensions about the tabs in the active space
([zen-browser/desktop#11210](https://github.com/zen-browser/desktop/issues/11210)),
so in Zen:

- The minimum tab count applies to each space separately (per window, or
  summed over each window's active space with "count across all windows").
- Tabs in a background space are left alone until that space becomes
  active. Switching to a space triggers a sweep right away, which then
  treats its tabs like any others.

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

To package the extension for addons.mozilla.org, with
[just](https://github.com/casey/just) and Node.js installed:

```sh
just lint    # the checks addons.mozilla.org runs on upload
just build   # writes web-ext-artifacts/auto_stash_tabs-<version>.zip
```

Both run `web-ext` through `npx` and leave `vendor/` out of the package.

### Integration tests

```sh
just test
```

builds a test copy of the package, then uses Selenium to launch a real browser with a
throwaway profile (never your own), install the package, and check what
gets stashed in a handful of scenarios (`test/integration.test.mjs`). It
runs headless and takes about half a minute.

- The browser is the first one found of Firefox, Firefox Developer Edition
  and Zen; set `FIREFOX_BINARY` to the path of an executable to choose one
  explicitly.
- `just test-headful` runs the same tests in a visible window.
- The first run downloads geckodriver (cached afterwards); set `GECKODRIVER`
  to use your own.

Not covered: tabs becoming idle through real elapsed time (the tests set the
idle threshold to 0 instead), and Zen spaces.

### Layout

| Path            | Purpose                                             |
| --------------- | --------------------------------------------------- |
| `manifest.json` | MV2 manifest (permissions: tabs, tabGroups, bookmarks, storage, alarms) |
| `background.js` | Idle tracking, sweep state machine, Tab Stash-compatible bookmark writing |
| `common.js`     | Shared settings defaults and helpers                 |
| `options.*`     | Settings page                                        |
| `popup.*`       | Toolbar popup (pause, lock tab, stash now, upcoming list) |
| `vendor/`       | Upstream projects as submodules, for reference only  |
| `Justfile`      | `just build` / `just lint` / `just test` tasks       |
| `test/`         | Integration tests and their browser harness          |
| `package.json`  | Dev dependencies for the tests (not shipped)         |

## License

[Apache License 2.0](LICENSE). The projects under `vendor/` are separate
works under their own licenses and are not part of the packaged extension.
