/* Integration tests: drive the built extension in a real browser with a
 * throwaway profile. Run with `just test`, which builds the package first.
 *
 * Each test opens tabs served by a local web server, changes the extension's
 * settings, and checks which tabs were closed and what was bookmarked.
 * Settings are written straight to storage, which allows an idle threshold
 * of 0 minutes so nothing has to wait for tabs to become idle.
 */

import assert from "node:assert/strict";
import {after, before, beforeEach, test} from "node:test";

import {inExtension, launch, startPageServer, waitFor} from "./harness.mjs";

const DEFAULT_FOLDER = /^saved-[-0-9:.T]+Z$/;
/** Longer than the extension's sweep debounce, to let a sweep happen. */
const SETTLE_MS = 2500;

let driver;
let server;
let isZen = false;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// --- Helpers that run inside the extension's options page -----------------

/** Close every tab but the control tab, delete the stash folder, and reset
 * settings to defaults with sweeping paused. */
function reset() {
  return inExtension(driver, async () => {
    const me = (await browser.tabs.getCurrent()).id;
    await browser.storage.local.remove(["settings", "stats"]);
    await browser.storage.local.set({
      settings: {...(await getSettings()), paused: true},
    });
    const tabs = await browser.tabs.query({});
    await browser.tabs.remove(tabs.filter(t => t.id !== me).map(t => t.id));
    for (const node of await browser.bookmarks.search({title: "Tab Stash"})) {
      if (!node.url) await browser.bookmarks.removeTree(node.id);
    }
  });
}

/** Merge overrides into the stored settings (one write, so one sweep). */
function configure(overrides) {
  return inExtension(
    driver,
    async o => saveSettings({...(await getSettings()), ...o}),
    overrides,
  );
}

/** Open background tabs for the named pages, oldest first, and wait for them
 * to load. Returns their tab IDs. */
async function openTabs(names, createProps = {}) {
  const ids = await inExtension(
    driver,
    async (urls, props) => {
      const out = [];
      for (const url of urls) {
        const tab = await browser.tabs.create({url, active: false, ...props});
        out.push(tab.id);
        // Keep lastAccessed times distinct so "least recently used" is
        // well defined.
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      return out;
    },
    names.map(server.url),
    createProps,
  );
  await waitFor(
    () =>
      inExtension(
        driver,
        async tabIds => {
          const tabs = await Promise.all(tabIds.map(id => browser.tabs.get(id)));
          return tabs.every(
            t => t.status === "complete" && t.url.startsWith("http"),
          );
        },
        ids,
      ),
    {what: "tabs to load"},
  );
  return ids;
}

/** Names of the open test pages (everything but the control tab), sorted by
 * name (tab strip order differs between browsers). */
async function openPages() {
  const urls = await inExtension(driver, async () => {
    const me = (await browser.tabs.getCurrent()).id;
    const tabs = await browser.tabs.query({});
    return tabs
      .filter(t => t.id !== me)
      .map(t => t.url);
  });
  return urls.map(pageName).sort();
}

/** The stash as a tree: [{title, name?, children?}], or null if there is no
 * "Tab Stash" folder. Bookmarks carry `name` (their page name). */
async function stashTree() {
  const tree = await inExtension(driver, async () => {
    const roots = (await browser.bookmarks.search({title: "Tab Stash"})).filter(
      n => !n.url,
    );
    if (roots.length === 0) return null;
    const [root] = await browser.bookmarks.getSubTree(roots[0].id);
    const simplify = node =>
      node.url
        ? {title: node.title, url: node.url}
        : {title: node.title, children: (node.children || []).map(simplify)};
    return simplify(root).children;
  });
  const name = node =>
    node.url
      ? {title: node.title, name: pageName(node.url)}
      : {title: node.title, children: node.children.map(name)};
  return tree && tree.map(name);
}

/** What the popup would be told: includes sweepState. */
function status() {
  return inExtension(driver, () =>
    browser.runtime.sendMessage({type: "getStatus"}),
  );
}

/** The pending sweep alarm, if any. */
function sweepAlarm() {
  return inExtension(driver, async () => {
    const alarm = await browser.alarms.get("auto-stash-sweep");
    return alarm ? {scheduledTime: alarm.scheduledTime, now: Date.now()} : null;
  });
}

function pageName(url) {
  return decodeURIComponent(new URL(url).pathname.slice(1));
}

function waitForOpenPages(count) {
  return waitFor(async () => (await openPages()).length === count, {
    what: `${count} test tabs to remain`,
  });
}

// --- Setup -----------------------------------------------------------------

before(async () => {
  server = await startPageServer();
  ({driver} = await launch());
  const info = await inExtension(driver, () => browser.runtime.getBrowserInfo());
  isZen = Boolean(info.zen);
  console.log(
    isZen
      ? `# testing in Zen ${info.zen.version} (Firefox ${info.version})`
      : `# testing in Firefox ${info.version}`,
  );
});

after(async () => {
  if (driver) await driver.quit();
  if (server) await server.close();
});

beforeEach(reset);

// --- Tests -----------------------------------------------------------------
// The control tab counts toward the minimum, so "minTabs: 3" leaves the
// control tab plus two test pages.

test("stashes the least recently used tabs down to the minimum", async () => {
  await openTabs(["p1", "p2", "p3", "p4", "p5", "p6"]);
  await configure({minTabs: 3, idleMinutes: 0, paused: false});

  await waitForOpenPages(2);
  assert.deepEqual(await openPages(), ["p5", "p6"]);

  const tree = await stashTree();
  assert.equal(tree.length, 1, "one stash folder");
  assert.match(tree[0].title, DEFAULT_FOLDER);
  assert.deepEqual(tree[0].children, [
    {title: "p1", name: "p1"},
    {title: "p2", name: "p2"},
    {title: "p3", name: "p3"},
    {title: "p4", name: "p4"},
  ]);

  const {stats, sweepState} = await status();
  assert.equal(stats.totalStashed, 4);
  assert.equal(sweepState, "idle");
  assert.equal(await sweepAlarm(), null, "no alarm once nothing can be stashed");
});

test("leaves tabs alone at or below the minimum", async () => {
  await openTabs(["p1", "p2"]);
  await configure({minTabs: 3, idleMinutes: 0, paused: false});
  await sleep(SETTLE_MS);

  assert.deepEqual(await openPages(), ["p1", "p2"]);
  assert.equal(await stashTree(), null, "no stash folder created");
  assert.equal((await status()).sweepState, "idle");
  assert.equal(await sweepAlarm(), null);
});

test("waits with a one-shot alarm for tabs that are not idle yet", async () => {
  await openTabs(["p1", "p2", "p3", "p4"]);
  await configure({minTabs: 3, idleMinutes: 30, paused: false});
  await sleep(SETTLE_MS);

  assert.equal((await openPages()).length, 4, "nothing stashed yet");
  assert.equal((await status()).sweepState, "later");
  const alarm = await sweepAlarm();
  assert.ok(alarm, "an alarm is armed");
  const minutes = (alarm.scheduledTime - alarm.now) / 60000;
  assert.ok(
    minutes > 28 && minutes <= 30,
    `alarm is ~30 minutes away (got ${minutes.toFixed(1)})`,
  );
});

test("sweeps when a tab is opened, without waiting for a timer", async () => {
  await openTabs(["p1", "p2"]);
  await configure({minTabs: 3, idleMinutes: 0, paused: false});
  await sleep(SETTLE_MS);
  assert.equal(await sweepAlarm(), null, "idle: no alarm armed");

  await openTabs(["p3", "p4"]);
  await waitForOpenPages(2);
  assert.deepEqual(await openPages(), ["p3", "p4"]);
});

test("'stash now' ignores idle time and the pause switch", async () => {
  await openTabs(["p1", "p2", "p3", "p4", "p5"]);
  await configure({minTabs: 3, idleMinutes: 30, paused: true});

  const result = await inExtension(driver, () =>
    browser.runtime.sendMessage({type: "sweepNow"}),
  );
  assert.deepEqual(result, {stashed: 3});
  assert.deepEqual(await openPages(), ["p4", "p5"]);
  assert.equal((await status()).sweepState, "idle", "still paused afterwards");
});

test("never stashes pinned or whitelisted tabs", async () => {
  await openTabs(["keep-pinned"], {pinned: true});
  await openTabs(["keep-listed", "p1", "p2", "p3"]);
  await configure({
    minTabs: 1,
    idleMinutes: 0,
    whitelist: "*/keep-listed",
    paused: false,
  });

  await waitForOpenPages(2);
  await sleep(SETTLE_MS);
  assert.deepEqual(await openPages(), ["keep-listed", "keep-pinned"]);
  const [folder] = await stashTree();
  assert.deepEqual(
    folder.children.map(c => c.name),
    ["p1", "p2", "p3"],
  );
});

test("skips bookmarking a URL that is already stashed", async () => {
  await openTabs(["dup", "dup", "p1"]);
  await configure({minTabs: 1, idleMinutes: 0, dedupe: true, paused: false});

  await waitForOpenPages(0);
  const [folder] = await stashTree();
  assert.deepEqual(
    folder.children.map(c => c.name),
    ["dup", "p1"],
  );
});

test("bookmarks duplicates when deduplication is off", async () => {
  await openTabs(["dup", "dup", "p1"]);
  await configure({minTabs: 1, idleMinutes: 0, dedupe: false, paused: false});

  await waitForOpenPages(0);
  const [folder] = await stashTree();
  assert.deepEqual(
    folder.children.map(c => c.name),
    ["dup", "dup", "p1"],
  );
});

test("puts grouped tabs in a subfolder named after the group", async t => {
  const [g1, g2] = await openTabs(["g1", "g2", "p1"]);
  const grouped = await inExtension(
    driver,
    async tabIds => {
      const groupId = await browser.tabs.group({tabIds});
      await browser.tabGroups.update(groupId, {title: "Research"});
      const tabs = await Promise.all(tabIds.map(id => browser.tabs.get(id)));
      return tabs.map(tab => ({groupId: tab.groupId, pinned: tab.pinned}));
    },
    [g1, g2],
  );
  if (grouped.some(tab => tab.pinned)) {
    // Zen turns tab groups into folders, which are always pinned, and
    // pinned tabs are exempt by default.
    t.skip("this browser pins grouped tabs");
    return;
  }
  await configure({minTabs: 1, idleMinutes: 0, paused: false});

  await waitForOpenPages(0);
  const [folder] = await stashTree();
  const subfolder = folder.children.find(c => c.children);
  assert.ok(subfolder, "a subfolder exists");
  assert.equal(subfolder.title, "Research");
  assert.deepEqual(
    subfolder.children.map(c => c.name),
    ["g1", "g2"],
  );
  assert.deepEqual(
    folder.children.filter(c => !c.children).map(c => c.name),
    ["p1"],
  );
});
