/* Auto Stash Tabs — background page.
 *
 * Periodically sweeps open tabs. Tabs that have been idle longer than the
 * configured threshold are bookmarked into the Tab Stash folder structure
 * (compatible with https://github.com/josh-berry/tab-stash) and closed, but
 * only while more than the configured number of tabs are open — the tab
 * count is never reduced below that minimum.
 *
 * Idle time comes from Firefox's native tab.lastAccessed, clamped by a
 * session-start grace period so a browser restart gives every restored tab a
 * fresh timer (same behavior as Tab Wrangler).
 */

"use strict";

const SWEEP_ALARM = "auto-stash-sweep";
const SWEEP_PERIOD_MINUTES = 1;

/** Tabs get a fresh idle timer from this instant (set at startup). */
let graceStart = Date.now();

/** Tab IDs the user has explicitly locked via the popup. Session-only. */
const lockedTabs = new Set();

// ---------------------------------------------------------------------------
// Idle tracking

function lastActive(tab) {
  return Math.max(tab.lastAccessed || 0, graceStart);
}

/** Reasons a tab can never be stashed, independent of idle time. */
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

/** Compute which tabs would be stashed right now.
 *
 * Returns {toStash, upcoming}: toStash is capped so no window (or the whole
 * browser, with countAllWindows) drops below settings.minTabs; upcoming is
 * every non-exempt tab with its remaining idle time, for the popup.
 */
async function computeSweepPlan(settings, {ignoreIdle = false} = {}) {
  const now = Date.now();
  const idleMs = settings.idleMinutes * 60 * 1000;
  const whitelistRes = parseWhitelist(settings.whitelist);

  const windows = await browser.windows.getAll({
    populate: true,
    windowTypes: ["normal"],
  });

  const groups = [];
  if (settings.countAllWindows) {
    groups.push(windows.filter(w => !w.incognito).flatMap(w => w.tabs || []));
  } else {
    for (const w of windows) {
      if (!w.incognito) groups.push(w.tabs || []);
    }
  }

  const toStash = [];
  const upcoming = [];
  for (const tabs of groups) {
    const excess = tabs.length - settings.minTabs;
    const candidates = tabs
      .filter(t => !isExempt(t, settings, whitelistRes))
      .sort((a, b) => lastActive(a) - lastActive(b));

    for (const tab of candidates) {
      const idleFor = now - lastActive(tab);
      upcoming.push({
        id: tab.id,
        title: tab.title || tab.url,
        url: tab.url,
        // Time until this tab reaches the idle threshold (<= 0 means ready).
        msLeft: idleMs - idleFor,
        blockedByCount: excess <= 0,
      });
    }

    if (excess <= 0) continue;
    toStash.push(
      ...candidates
        .filter(t => ignoreIdle || now - lastActive(t) >= idleMs)
        .slice(0, excess),
    );
  }
  upcoming.sort((a, b) => a.msLeft - b.msLeft);
  return {toStash, upcoming};
}

// ---------------------------------------------------------------------------
// Tab Stash-compatible bookmark storage
//
// Mirrors the conventions in vendor/tab-stash/src/model/bookmarks.ts and
// model/index.ts: a root folder titled exactly "Tab Stash" (shallowest, then
// oldest wins if there are several), unnamed groups named
// "saved-<ISO timestamp>" inserted at index 0, and reuse of the topmost
// unnamed group while it is recent enough.

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

async function ensureStashRoot() {
  const findCandidates = async () => {
    const results = await browser.bookmarks.search({title: STASH_ROOT_NAME});
    const folders = results.filter(
      n => !n.url && n.title === STASH_ROOT_NAME,
    );
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
      );
  };

  let candidates = await findCandidates();
  if (candidates.length === 0) {
    // Like Tab Stash, create it with no explicit parent (lands in the
    // browser's default bookmarks location), then re-search in case another
    // extension created one concurrently.
    await browser.bookmarks.create({title: STASH_ROOT_NAME});
    candidates = await findCandidates();
  }
  return candidates[0];
}

/** Find or create the folder new bookmarks should go into. Mirrors Tab
 * Stash's defaultStashDestFolder()/createStashFolder(). */
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

let sweeping = false;

async function sweep({manual = false} = {}) {
  if (sweeping) return {stashed: 0};
  sweeping = true;
  try {
    const settings = await getSettings();
    if (settings.paused && !manual) return {stashed: 0};

    const {toStash} = await computeSweepPlan(settings, {ignoreIdle: manual});
    if (toStash.length === 0) return {stashed: 0};

    const root = await ensureStashRoot();
    const folder = await ensureDestFolder(root, settings);
    const existing = settings.dedupe
      ? await urlsUnderStashRoot(root)
      : new Set();

    let stashed = 0;
    const recent = [];
    for (const tab of toStash) {
      const url = unwrapUrl(tab.url);
      try {
        if (!existing.has(url)) {
          await browser.bookmarks.create({
            parentId: folder.id,
            title: tab.title || url,
            url,
          });
          existing.add(url);
        }
        // Only close the tab once the bookmark definitely exists.
        await browser.tabs.remove(tab.id);
        stashed++;
        recent.push({title: tab.title || url, url, time: Date.now()});
      } catch (e) {
        console.error("auto-stash-tabs: failed to stash tab", tab.url, e);
      }
    }

    if (stashed > 0) await recordStats(stashed, recent);
    return {stashed};
  } finally {
    sweeping = false;
  }
}

async function recordStats(count, newEntries) {
  const stats = (await browser.storage.local.get("stats")).stats || {
    totalStashed: 0,
    lastStashTime: null,
    recent: [],
  };
  stats.totalStashed += count;
  stats.lastStashTime = Date.now();
  stats.recent = [...newEntries.reverse(), ...stats.recent].slice(0, 20);
  await browser.storage.local.set({stats});
}

// ---------------------------------------------------------------------------
// Badge

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
});
browser.runtime.onInstalled.addListener(() => {
  graceStart = Date.now();
});

browser.tabs.onRemoved.addListener(tabId => lockedTabs.delete(tabId));

browser.alarms.create(SWEEP_ALARM, {periodInMinutes: SWEEP_PERIOD_MINUTES});
browser.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === SWEEP_ALARM) {
    sweep().catch(e => console.error("auto-stash-tabs: sweep failed", e));
  }
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) updateBadge();
});
updateBadge();

browser.runtime.onMessage.addListener(async message => {
  switch (message.type) {
    case "getStatus": {
      const settings = await getSettings();
      const {upcoming} = await computeSweepPlan(settings);
      const stats = (await browser.storage.local.get("stats")).stats || {
        totalStashed: 0,
        lastStashTime: null,
        recent: [],
      };
      return {
        settings,
        upcoming: upcoming.slice(0, 8),
        lockedTabIds: [...lockedTabs],
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
      return {ok: true};
  }
});
