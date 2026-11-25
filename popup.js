"use strict";

let activeTabId = null;

/** Format the time until a tab can be stashed.
 * @param {number} ms Milliseconds remaining; <= 0 means it is ready now.
 * @returns {string} "ready", "12m", or "1h 5m". */
function fmtEta(ms) {
  if (ms <= 0) return "ready";
  const min = Math.ceil(ms / 60000);
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}h ${min % 60}m`;
}

/** Fetch the current status from the background page and redraw the whole
 * popup (pause button, lock checkbox, summary, upcoming and recent lists).
 * @returns {Promise<void>} */
async function refresh() {
  const [activeTab] = await browser.tabs.query({
    active: true,
    currentWindow: true,
  });
  activeTabId = activeTab ? activeTab.id : null;

  const status = await browser.runtime.sendMessage({type: "getStatus"});
  const {settings, upcoming, recent, lockedTabIds, stats} = status;

  const pauseBtn = document.getElementById("pauseBtn");
  pauseBtn.textContent = settings.paused ? "▶ Resume" : "⏸ Pause";
  pauseBtn.dataset.paused = settings.paused ? "1" : "";

  document.getElementById("lockTab").checked =
    activeTabId !== null && lockedTabIds.includes(activeTabId);

  const summary = document.getElementById("summary");
  const parts = [];
  if (settings.paused) parts.push("Paused.");
  if (stats.totalStashed > 0) {
    parts.push(`${stats.totalStashed} tabs stashed so far.`);
  }
  parts.push(
    upcoming.length > 0
      ? "Next to be stashed:"
      : "No tabs eligible for stashing.",
  );
  summary.textContent = parts.join(" ");

  const list = document.getElementById("upcoming");
  list.textContent = "";
  for (const item of upcoming) {
    const li = document.createElement("li");
    const title = document.createElement("span");
    title.className = "title";
    title.textContent = item.title;
    title.title = item.url;
    const eta = document.createElement("span");
    eta.className = "eta";
    eta.textContent = item.blockedByCount
      ? "kept (tab count)"
      : fmtEta(item.msLeft);
    li.append(title, eta);
    list.append(li);
  }

  renderRecent(recent);
}

/** Format how long ago something happened.
 * @param {number} ms Elapsed milliseconds.
 * @returns {string} "just now", "12m ago", "3h ago", or "2d ago". */
function fmtAgo(ms) {
  const min = Math.floor(ms / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Draw the "Recently stashed" list; each entry reopens its page when
 * clicked. The whole section is hidden when there is nothing to show.
 * @param {{title: string, url: string, time: number}[]} recent Newest first.
 * @returns {void} */
function renderRecent(recent) {
  document.getElementById("recentSection").hidden = recent.length === 0;
  const list = document.getElementById("recent");
  list.textContent = "";
  const now = Date.now();
  for (const item of recent) {
    const li = document.createElement("li");
    const link = document.createElement("a");
    link.className = "title";
    link.href = item.url;
    link.textContent = item.title;
    link.title = item.url;
    const ago = document.createElement("span");
    ago.className = "eta";
    ago.textContent = fmtAgo(now - item.time);
    li.append(link, ago);
    list.append(li);
  }
}

/** Click handler for the recent list: reopen the clicked page in a new tab.
 * Ctrl/Cmd/middle-click opens it in the background and keeps the popup open.
 * The bookmark is left in place.
 * @param {MouseEvent} e A click or auxclick inside the list.
 * @returns {void} */
function onRecentClick(e) {
  const link = e.target.closest("a");
  if (!link || (e.type === "auxclick" && e.button !== 1)) return;
  e.preventDefault();
  const background = e.ctrlKey || e.metaKey || e.button === 1;
  browser.tabs
    .create({url: link.href, active: !background})
    .then(() => {
      if (!background) window.close();
    })
    .catch(err => console.error("auto-stash-tabs: could not reopen", err));
}
document.getElementById("recent").addEventListener("click", onRecentClick);
document.getElementById("recent").addEventListener("auxclick", onRecentClick);

document.getElementById("pauseBtn").addEventListener("click", async e => {
  await browser.runtime.sendMessage({
    type: "setPaused",
    paused: !e.target.dataset.paused,
  });
  refresh();
});

document.getElementById("lockTab").addEventListener("change", async e => {
  if (activeTabId === null) return;
  await browser.runtime.sendMessage({
    type: "setLocked",
    tabId: activeTabId,
    locked: e.target.checked,
  });
});

document.getElementById("stashNow").addEventListener("click", async () => {
  await browser.runtime.sendMessage({type: "sweepNow"});
  refresh();
});

document.getElementById("openOptions").addEventListener("click", e => {
  e.preventDefault();
  browser.runtime.openOptionsPage();
  window.close();
});

refresh();
