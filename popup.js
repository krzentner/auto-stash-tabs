"use strict";

let activeTabId = null;

function fmtEta(ms) {
  if (ms <= 0) return "ready";
  const min = Math.ceil(ms / 60000);
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}h ${min % 60}m`;
}

async function refresh() {
  const [activeTab] = await browser.tabs.query({
    active: true,
    currentWindow: true,
  });
  activeTabId = activeTab ? activeTab.id : null;

  const status = await browser.runtime.sendMessage({type: "getStatus"});
  const {settings, upcoming, lockedTabIds, stats} = status;

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
}

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
