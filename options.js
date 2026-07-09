"use strict";

const NUMBER_FIELDS = ["idleMinutes", "minTabs", "groupingMinutes"];
const BOOL_FIELDS = ["countAllWindows", "skipPinned", "skipAudible", "dedupe"];

async function load() {
  const s = await getSettings();
  for (const f of NUMBER_FIELDS) document.getElementById(f).value = s[f];
  for (const f of BOOL_FIELDS) document.getElementById(f).checked = s[f];
  document.getElementById("whitelist").value = s.whitelist;
}

async function save() {
  const s = await getSettings();
  for (const f of NUMBER_FIELDS) {
    const v = parseInt(document.getElementById(f).value, 10);
    if (!Number.isNaN(v) && v >= 0) s[f] = v;
  }
  for (const f of BOOL_FIELDS) s[f] = document.getElementById(f).checked;
  s.whitelist = document.getElementById("whitelist").value;
  await saveSettings(s);

  const status = document.getElementById("status");
  status.textContent = "Saved.";
  setTimeout(() => (status.textContent = ""), 1500);
}

document.getElementById("save").addEventListener("click", save);
load();
