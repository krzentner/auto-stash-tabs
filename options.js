"use strict";

const NUMBER_FIELDS = ["idleMinutes", "minTabs", "groupingMinutes"];
const BOOL_FIELDS = [
  "countAllWindows",
  "countAllGroups",
  "skipPinned",
  "skipAudible",
  "dedupe",
];

async function load() {
  const s = await getSettings();
  for (const f of NUMBER_FIELDS) document.getElementById(f).value = s[f];
  for (const f of BOOL_FIELDS) document.getElementById(f).checked = s[f];
  document.getElementById("whitelist").value = s.whitelist;
}

async function save() {
  const s = await getSettings();
  for (const f of NUMBER_FIELDS) {
    // Enforce each input's own min attribute (out-of-range values are
    // ignored and the previous setting kept).
    const input = document.getElementById(f);
    const v = parseInt(input.value, 10);
    if (!Number.isNaN(v) && v >= Number(input.min)) s[f] = v;
  }
  for (const f of BOOL_FIELDS) s[f] = document.getElementById(f).checked;
  s.whitelist = document.getElementById("whitelist").value;
  await saveSettings(s);
  // Show what was actually stored, in case a value was rejected.
  await load();

  const status = document.getElementById("status");
  status.textContent = "Saved.";
  setTimeout(() => (status.textContent = ""), 1500);
}

document.getElementById("save").addEventListener("click", save);
load();
