/* Auto Stash Tabs — background page.
 *
 * Tabs that have been idle longer than the configured threshold are
 * bookmarked into the Tab Stash folder structure (compatible with
 * https://github.com/josh-berry/tab-stash) and closed, but only while more
 * than the configured number of tabs are open — the tab count is never
 * reduced below that minimum.
 *
 * Idle time comes from Firefox's native tab.lastAccessed, clamped by a
 * session-start grace period so a browser restart gives every restored tab a
 * fresh timer (same behavior as Tab Wrangler).
 *
 * Activation flow
 * ---------------
 * Nothing runs on a fixed timer. Everything starts from one of the listeners
 * under "Wiring" at the bottom of this file:
 *
 *   tab opened / activated / attached / un-exempted,
 *   settings changed, tab unlocked, sweep alarm fired, startup
 *       │
 *       ▼
 *   requestSweep()          debounces bursts of events into one sweep
 *       │
 *       ▼
 *   sweep()                 one at a time; a request arriving mid-sweep
 *       │                   queues exactly one more via requestSweep()
 *       ├─▶ assessSweep()   ─▶ computeSweepPlan() ─▶ isExempt(), lastActive()
 *       │                   classifies the tabs as NOW / LATER / IDLE
 *       │
 *       ├─▶ stashTabs()     only in state NOW: for each planned tab,
 *       │       │           re-check it, bookmark it, then close it
 *       │       ├─▶ ensureStashRoot() ─▶ findStashRoot() ─▶ bookmarkDepth()
 *       │       ├─▶ ensureDestFolder()
 *       │       ├─▶ urlsUnderStashRoot()        (if deduplicating)
 *       │       ├─▶ ensureGroupFolder()         (for tabs in a tab group)
 *       │       └─▶ recordStats() ─▶ getStats()
 *       │
 *       ├─▶ assessSweep()   again after stashing
 *       │
 *       └─▶ settle()        LATER: arm a one-shot alarm for when the next
 *                           tab goes idle (which re-enters requestSweep());
 *                           IDLE: clear the alarm and wait for an event
 *
 * The popup talks to this page through runtime messages (last listener
 * below): "getStatus" calls computeSweepPlan(), recentlyStashed() (which
 * reads the stash bookmarks via findStashRoot()) and getStats() directly,
 * "sweepNow" calls sweep({manual: true}), and "setPaused"/"setLocked" change
 * state that leads back into requestSweep(). updateBadge() runs at load and
 * whenever settings change.
 *
 * Settings and URL helpers (getSettings, unwrapUrl, isStashableUrl, ...) live
 * in common.js, which is loaded before this script.
 */

"use strict";

const SWEEP_ALARM = "auto-stash-sweep";
/** Scheduled sweeps are never less than this far apart. */
const SWEEP_MIN_GAP_MS = 60 * 1000;
/** Delay between an event that might require a sweep and the sweep. */
const SWEEP_DEBOUNCE_MS = 1000;

/** Tabs get a fresh idle timer from this instant (set at startup). */
let graceStart = Date.now();

/** Tab IDs the user has explicitly locked via the popup. Session-only. */
const lockedTabs = new Set();

// ---------------------------------------------------------------------------
// Idle tracking

/** When a tab was last used, for idle purposes: its lastAccessed time, but
 * no earlier than the start of the grace period.
 * @param {tabs.Tab} tab
 * @returns {number} Milliseconds since the epoch. */
function lastActive(tab) {
  return Math.max(tab.lastAccessed || 0, graceStart);
}

/** Why a tab can never be stashed, independent of idle time.
 * @param {tabs.Tab} tab
 * @param {object} settings As returned by getSettings().
 * @param {RegExp[]} whitelistRes As returned by parseWhitelist().
 * @returns {string|null} A short reason such as "pinned", or null if the tab
 *   is eligible. */
function isExempt(tab, settings, whitelistRes) {
  if (tab.active) return "active";
  // Multi-selected tabs (active is always highlighted, checked above).
  if (tab.highlighted) return "selected";
  if (tab.hidden) return "hidden";
  if (tab.attention) return "attention";
  if (settings.skipPinned && tab.pinned) return "pinned";
  if (settings.skipAudible && tab.audible) return "audible";
  const sharing = tab.sharingState;
  if (sharing && (sharing.camera || sharing.microphone || sharing.screen))
    return "sharing";
  if (lockedTabs.has(tab.id)) return "locked";
  const url = unwrapUrl(tab.url);
  if (!isStashableUrl(url)) return "unstashable";
  if (isWhitelisted(url, whitelistRes)) return "whitelisted";
  return null;
}

/** Compute which tabs would be stashed right now. Reads the open tabs but
 * changes nothing.
 *
 * Tabs are split into pools (per window, per tab group, or one for the whole
 * browser, depending on settings) and settings.minTabs applies to each pool.
 *
 * @param {object} settings As returned by getSettings().
 * @param {{ignoreIdle?: boolean}} [options] ignoreIdle: treat every eligible
 *   tab as idle (used by the manual "stash now").
 * @returns {Promise<{toStash: tabs.Tab[], upcoming: object[]}>}
 *   toStash: tabs to stash now, capped so no pool drops below minTabs.
 *   upcoming: every non-exempt tab as {id, title, url, lastAccessed, msLeft,
 *   blockedByCount}, stashable ones first, soonest first. msLeft is the time
 *   until the tab is idle enough (<= 0 means ready); blockedByCount means it
 *   is being kept to hold its pool at minTabs. */
async function computeSweepPlan(settings, {ignoreIdle = false} = {}) {
  const now = Date.now();
  const idleMs = settings.idleMinutes * 60 * 1000;
  const whitelistRes = parseWhitelist(settings.whitelist);

  const windows = await browser.windows.getAll({
    populate: true,
    windowTypes: ["normal"],
  });

  // Partition tabs into pools; minTabs applies to each pool independently.
  // Collapsed tab groups look no different from expanded ones here (Firefox
  // collapses them purely visually), so grouped tabs are always swept.
  const pools = new Map();
  for (const w of windows) {
    if (w.incognito) continue;
    for (const tab of w.tabs || []) {
      // Hidden tabs (e.g. parked by another extension) are never stashed and
      // aren't visibly "open", so they don't count toward minTabs either.
      if (tab.hidden) continue;
      const grouped = isGrouped(tab);
      const key =
        !settings.countAllGroups && grouped
          ? `group:${tab.groupId}`
          : settings.countAllWindows
            ? "all"
            : `window:${w.id}`;
      if (!pools.has(key)) pools.set(key, []);
      pools.get(key).push(tab);
    }
  }

  const toStash = [];
  const upcoming = [];
  for (const tabs of pools.values()) {
    const excess = tabs.length - settings.minTabs;
    // Sort by raw lastAccessed, not the grace-clamped lastActive(): right
    // after install/startup the clamp gives every tab the same timestamp,
    // which would make the pick below arbitrary. Raw recency ensures that
    // when more tabs than the excess are past the idle threshold (fresh
    // install, TTL lowered, machine suspended), the longest-idle tabs are
    // stashed and the most recently used ones are kept.
    const candidates = tabs
      .filter(t => !isExempt(t, settings, whitelistRes))
      .sort((a, b) => (a.lastAccessed || 0) - (b.lastAccessed || 0));

    candidates.forEach((tab, i) => {
      const idleFor = now - lastActive(tab);
      upcoming.push({
        id: tab.id,
        title: tab.title || tab.url,
        url: tab.url,
        lastAccessed: tab.lastAccessed || 0,
        // Time until this tab reaches the idle threshold (<= 0 means ready).
        msLeft: idleMs - idleFor,
        // Only the `excess` least recently used candidates can be stashed;
        // the rest are kept to hold the pool at minTabs.
        blockedByCount: i >= excess,
      });
    });

    if (excess <= 0) continue;
    toStash.push(
      ...candidates
        .filter(t => ignoreIdle || now - lastActive(t) >= idleMs)
        .slice(0, excess),
    );
  }
  // Tabs that can actually be stashed come first. Tie-break by raw recency so
  // the displayed order matches stash order even while the startup grace
  // period makes msLeft identical.
  upcoming.sort(
    (a, b) =>
      a.blockedByCount - b.blockedByCount ||
      a.msLeft - b.msLeft ||
      a.lastAccessed - b.lastAccessed,
  );
  return {toStash, upcoming};
}

// ---------------------------------------------------------------------------
// Tab Stash-compatible bookmark storage
//
// Mirrors the conventions in vendor/tab-stash/src/model/bookmarks.ts and
// model/index.ts: a root folder titled exactly "Tab Stash" (shallowest, then
// oldest wins if there are several), unnamed groups named
// "saved-<ISO timestamp>" inserted at index 0, reuse of the topmost unnamed
// group while it is recent enough, and (as of Tab Stash 3.5) a subfolder per
// Firefox tab group.

/** How many ancestors a bookmark node has.
 * @param {bookmarks.BookmarkTreeNode} node
 * @returns {Promise<number>} 0 for the bookmark tree's root. */
async function bookmarkDepth(node) {
  let depth = 0;
  let parentId = node.parentId;
  while (parentId !== undefined) {
    depth++;
    const [parent] = await browser.bookmarks.get(parentId);
    parentId = parent.parentId;
  }
  return depth;
}

/** Find the "Tab Stash" root folder without creating it, choosing the same
 * one Tab Stash would if there are several.
 * @returns {Promise<bookmarks.BookmarkTreeNode|undefined>} The root folder,
 *   or undefined if there is none yet. */
async function findStashRoot() {
  const results = await browser.bookmarks.search({title: STASH_ROOT_NAME});
  const folders = results.filter(n => !n.url && n.title === STASH_ROOT_NAME);
  const withDepth = [];
  for (const f of folders) {
    withDepth.push({folder: f, depth: await bookmarkDepth(f)});
  }
  // Same ranking as Tab Stash: closest to the root wins, ties broken by
  // creation date, then by id, so both extensions choose the same folder.
  const minDepth = Math.min(...withDepth.map(c => c.depth));
  return withDepth
    .filter(c => c.depth <= minDepth)
    .map(c => c.folder)
    .sort(
      (a, b) =>
        (a.dateAdded || 0) - (b.dateAdded || 0) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )[0];
}

/** Find the "Tab Stash" root folder, creating it if there is none.
 * @returns {Promise<bookmarks.BookmarkTreeNode>} The root folder. */
async function ensureStashRoot() {
  const existing = await findStashRoot();
  if (existing) return existing;
  // Like Tab Stash, create it with no explicit parent (lands in the
  // browser's default bookmarks location), then re-search in case another
  // extension created one concurrently. Fall back to the one we created in
  // case the search doesn't see it yet.
  const created = await browser.bookmarks.create({title: STASH_ROOT_NAME});
  return (await findStashRoot()) || created;
}

/** The most recently stashed tabs, read from the bookmarks under the stash
 * root. Because it reads the bookmarks themselves, it includes tabs stashed
 * by Tab Stash or on another synced device, and drops ones that have since
 * been deleted.
 * @param {number} limit Maximum number of entries; 0 returns none.
 * @returns {Promise<{title: string, url: string, time: number}[]>} Newest
 *   first; time is when the bookmark was added. */
async function recentlyStashed(limit) {
  if (limit <= 0) return [];
  const root = await findStashRoot();
  if (!root) return [];
  const [tree] = await browser.bookmarks.getSubTree(root.id);
  const found = [];
  const walk = node => {
    if (node.url) {
      found.push({
        title: node.title || node.url,
        url: node.url,
        time: node.dateAdded || 0,
        order: found.length,
      });
    }
    for (const child of node.children || []) walk(child);
  };
  walk(tree);
  // Newest first; bookmarks added in the same millisecond keep the reverse
  // of their order in the tree.
  found.sort((a, b) => b.time - a.time || b.order - a.order);
  return found.slice(0, limit).map(({title, url, time}) => ({title, url, time}));
}

/** Find or create the folder new bookmarks should go into: the topmost
 * "saved-..." folder under the root if it is newer than
 * settings.groupingMinutes, otherwise a new one at the top. Mirrors Tab
 * Stash's defaultStashDestFolder()/createStashFolder().
 * @param {bookmarks.BookmarkTreeNode} root From ensureStashRoot().
 * @param {object} settings As returned by getSettings().
 * @returns {Promise<bookmarks.BookmarkTreeNode>} The destination folder. */
async function ensureDestFolder(root, settings) {
  const children = await browser.bookmarks.getChildren(root.id);
  const topmost = children[0];
  if (
    topmost &&
    !topmost.url &&
    getDefaultFolderNameISODate(topmost.title) !== null &&
    (topmost.dateAdded || 0) >=
      Date.now() - settings.groupingMinutes * 60 * 1000
  ) {
    return topmost;
  }
  return browser.bookmarks.create({
    parentId: root.id,
    title: genDefaultFolderName(new Date()),
    index: 0,
  });
}

/** Bookmark folder last used for each Firefox tab group (groupId -> bookmark
 * id), so tabs trickling out of an untitled group land in one folder.
 * Session-only, like the group IDs themselves. */
const groupFolderIds = new Map();

/** Whether a tab is in a Firefox tab group.
 * @param {tabs.Tab} tab
 * @returns {boolean} */
function isGrouped(tab) {
  // groupId is -1 for ungrouped tabs.
  return tab.groupId >= 0;
}

/** Find or create the subfolder of `dest` that holds tabs from a Firefox tab
 * group. Mirrors how Tab Stash (3.5+) saves a tab group: a child folder
 * titled with the group's name, or a default "saved-..." name if the group
 * is untitled. Tab Stash can restore such a folder as a tab group.
 * @param {bookmarks.BookmarkTreeNode} dest From ensureDestFolder().
 * @param {number} groupId The tab's groupId.
 * @returns {Promise<bookmarks.BookmarkTreeNode>} The group's subfolder. */
async function ensureGroupFolder(dest, groupId) {
  const knownId = groupFolderIds.get(groupId);
  if (knownId) {
    try {
      const [node] = await browser.bookmarks.get(knownId);
      if (node && !node.url && node.parentId === dest.id) return node;
    } catch (e) {
      // The folder was deleted; fall through and make a new one.
    }
  }

  let title = "";
  try {
    title = (await browser.tabGroups.get(groupId)).title || "";
  } catch (e) {
    // Group vanished mid-sweep; treat it as untitled.
  }

  let folder;
  if (title) {
    const children = await browser.bookmarks.getChildren(dest.id);
    folder = children.find(
      c => !c.url && c.type !== "separator" && c.title === title,
    );
  }
  if (!folder) {
    folder = await browser.bookmarks.create({
      parentId: dest.id,
      title: title || genDefaultFolderName(new Date()),
    });
  }
  groupFolderIds.set(groupId, folder.id);
  return folder;
}

/** Collect every URL already bookmarked anywhere under the stash root, for
 * deduplication.
 * @param {bookmarks.BookmarkTreeNode} root From ensureStashRoot().
 * @returns {Promise<Set<string>>} */
async function urlsUnderStashRoot(root) {
  const urls = new Set();
  const [tree] = await browser.bookmarks.getSubTree(root.id);
  const walk = node => {
    if (node.url) urls.add(node.url);
    for (const child of node.children || []) walk(child);
  };
  walk(tree);
  return urls;
}

// ---------------------------------------------------------------------------
// The sweep

//
// There is no periodic timer. Instead a small state machine decides when to
// look at the tabs again:
//
//   NOW    Some tab can be stashed right now. Stash, then re-assess.
//   LATER  Nothing to stash yet, but a tab will become idle enough if left
//          alone. A one-shot alarm is armed for that moment.
//   IDLE   Nothing can be stashed until something else changes (too few
//          tabs, everything exempt, or paused). No alarm is armed, so an
//          idle browser is never woken up.
//
// The state is re-assessed whenever something happens that could change it
// (a tab is opened or activated, an exemption or setting changes — see the
// listeners under "Wiring") and when the LATER alarm fires.

const SweepState = {NOW: "now", LATER: "later", IDLE: "idle"};
let sweepState = SweepState.IDLE;

/** Work out which state the current tabs put us in. Changes nothing.
 * @param {object} settings As returned by getSettings().
 * @returns {Promise<{state: string, toStash?: tabs.Tab[], msLeft?: number}>}
 *   state is a SweepState value. NOW comes with toStash (the tabs to stash);
 *   LATER comes with msLeft (time until the next tab is idle enough). */
async function assessSweep(settings) {
  if (settings.paused) return {state: SweepState.IDLE};
  const {toStash, upcoming} = await computeSweepPlan(settings);
  if (toStash.length > 0) return {state: SweepState.NOW, toStash};
  // `upcoming` is sorted with stashable tabs first, soonest first.
  const next = upcoming[0];
  if (next && !next.blockedByCount) {
    return {state: SweepState.LATER, msLeft: next.msLeft};
  }
  return {state: SweepState.IDLE};
}

/** Enter a resting state (LATER or IDLE), arming or clearing the alarm, and
 * record it in sweepState.
 * @param {{state: string, msLeft?: number}} need From assessSweep().
 * @returns {Promise<void>} */
async function settle(need) {
  if (need.state === SweepState.IDLE) {
    sweepState = SweepState.IDLE;
    await browser.alarms.clear(SWEEP_ALARM);
    return;
  }
  // Still NOW after stashing means some tab couldn't be stashed; retry later
  // rather than spinning.
  sweepState = SweepState.LATER;
  browser.alarms.create(SWEEP_ALARM, {
    // Never sooner than the minimum gap, which bounds how often we wake up
    // when many tabs go idle one after another.
    when: Date.now() + Math.max(need.msLeft || 0, SWEEP_MIN_GAP_MS),
  });
}

let sweeping = false;
/** A sweep was requested while one was running; run another afterwards. */
let sweepAgain = false;
let sweepTimer = null;

/** Request a sweep soon. Debounced, since tab events arrive in bursts (e.g.
 * session restore). Safe to use directly as an event listener; any
 * arguments are ignored.
 * @returns {void} */
function requestSweep() {
  if (sweepTimer !== null) return;
  sweepTimer = setTimeout(() => {
    sweepTimer = null;
    sweep().catch(e => console.error("auto-stash-tabs: sweep failed", e));
  }, SWEEP_DEBOUNCE_MS);
}

/** Run the state machine once: assess, stash if the state is NOW, then
 * settle into LATER or IDLE. Only one sweep runs at a time; a call made
 * while another is running does nothing itself but queues one more.
 * @param {{manual?: boolean}} [options] manual: the user asked for it, so
 *   ignore idle time and the pause switch (minTabs still applies).
 * @returns {Promise<{stashed: number}>} How many tabs were stashed. */
async function sweep({manual = false} = {}) {
  if (sweeping) {
    sweepAgain = true;
    return {stashed: 0};
  }
  sweeping = true;
  try {
    const settings = await getSettings();
    let need = await assessSweep(settings);
    if (manual) {
      // "Stash now" ignores idle time (and the pause switch).
      const plan = await computeSweepPlan(settings, {ignoreIdle: true});
      need = {state: SweepState.NOW, toStash: plan.toStash};
    }

    let stashed = 0;
    if (need.state === SweepState.NOW) {
      sweepState = SweepState.NOW;
      stashed = await stashTabs(settings, need.toStash);
      need = await assessSweep(settings);
    }
    await settle(need);
    return {stashed};
  } finally {
    sweeping = false;
    if (sweepAgain) {
      sweepAgain = false;
      requestSweep();
    }
  }
}

/** Bookmark and close the given tabs. Each tab is re-checked first and
 * skipped if it has since closed, navigated, or become exempt; a tab is only
 * closed once its bookmark exists. Failures are logged and skipped.
 * @param {object} settings As returned by getSettings().
 * @param {tabs.Tab[]} toStash From computeSweepPlan() or assessSweep().
 * @returns {Promise<number>} How many tabs were stashed. */
async function stashTabs(settings, toStash) {
  if (toStash.length === 0) return 0;

  const root = await ensureStashRoot();
  const folder = await ensureDestFolder(root, settings);
  const existing = settings.dedupe ? await urlsUnderStashRoot(root) : null;
  const whitelistRes = parseWhitelist(settings.whitelist);

  let stashed = 0;
  for (const tab of toStash) {
    const url = unwrapUrl(tab.url);
    try {
      // The plan is a snapshot and stashing takes a while; skip tabs that
      // were closed, navigated, or became exempt (e.g. activated) since.
      const current = await browser.tabs.get(tab.id).catch(() => null);
      if (
        !current ||
        current.url !== tab.url ||
        isExempt(current, settings, whitelistRes)
      ) {
        continue;
      }

      if (!existing || !existing.has(url)) {
        const parent = isGrouped(tab)
          ? await ensureGroupFolder(folder, tab.groupId)
          : folder;
        await browser.bookmarks.create({
          parentId: parent.id,
          title: tab.title || url,
          url,
        });
        if (existing) existing.add(url);
      }
      // Only close the tab once the bookmark definitely exists.
      await browser.tabs.remove(tab.id);
      stashed++;
    } catch (e) {
      console.error("auto-stash-tabs: failed to stash tab", tab.url, e);
    }
  }

  if (stashed > 0) await recordStats(stashed);
  return stashed;
}

/** Load the stashing statistics shown in the popup.
 * @returns {Promise<{totalStashed: number, lastStashTime: number|null}>}
 *   Stored stats, or zeroed defaults if none have been saved. */
async function getStats() {
  const {stats} = await browser.storage.local.get("stats");
  return {
    totalStashed: (stats && stats.totalStashed) || 0,
    lastStashTime: (stats && stats.lastStashTime) || null,
  };
}

/** Add a finished sweep to the stored statistics.
 * @param {number} count How many tabs were stashed.
 * @returns {Promise<void>} */
async function recordStats(count) {
  const stats = await getStats();
  stats.totalStashed += count;
  stats.lastStashTime = Date.now();
  await browser.storage.local.set({stats});
}

// ---------------------------------------------------------------------------
// Badge

/** Show "II" on the toolbar button while paused, nothing otherwise.
 * @returns {Promise<void>} */
async function updateBadge() {
  const settings = await getSettings();
  await browser.browserAction.setBadgeText({
    text: settings.paused ? "II" : "",
  });
  await browser.browserAction.setBadgeBackgroundColor({color: "#7a6d00"});
}

// ---------------------------------------------------------------------------
// Wiring

browser.runtime.onStartup.addListener(() => {
  graceStart = Date.now();
  requestSweep();
});
browser.runtime.onInstalled.addListener(() => {
  graceStart = Date.now();
  requestSweep();
});

browser.tabs.onRemoved.addListener(tabId => lockedTabs.delete(tabId));

// Events after which a sweep might be needed. Closing tabs never is, so
// onRemoved isn't here.
// - A tab was opened, or moved into a window: a pool may now be over minTabs.
browser.tabs.onCreated.addListener(requestSweep);
browser.tabs.onAttached.addListener(requestSweep);
// - A tab was activated: the previously active tab is no longer exempt. In
//   Zen this is also the only sign that the active space (and so the set of
//   tabs we can see) has changed.
browser.tabs.onActivated.addListener(requestSweep);
// - Something that exempted a tab may have stopped doing so.
browser.tabs.onUpdated.addListener(requestSweep, {
  properties: ["pinned", "audible", "hidden", "attention", "sharingState", "url"],
});

browser.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === SWEEP_ALARM) requestSweep();
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) {
    updateBadge();
    requestSweep();
  }
});
updateBadge();
requestSweep();

browser.runtime.onMessage.addListener(async message => {
  switch (message.type) {
    case "getStatus": {
      const settings = await getSettings();
      const {upcoming} = await computeSweepPlan(settings);
      const stats = await getStats();
      return {
        settings,
        upcoming: upcoming.slice(0, 3),
        recent: await recentlyStashed(settings.recentCount),
        lockedTabIds: [...lockedTabs],
        sweepState,
        stats,
      };
    }
    case "sweepNow":
      return sweep({manual: true});
    case "setPaused": {
      const settings = await getSettings();
      settings.paused = message.paused;
      await saveSettings(settings);
      return {ok: true};
    }
    case "setLocked":
      if (message.locked) lockedTabs.add(message.tabId);
      else lockedTabs.delete(message.tabId);
      requestSweep();
      return {ok: true};
  }
});
