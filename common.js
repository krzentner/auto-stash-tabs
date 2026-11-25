/* Shared constants and helpers, loaded by background, options, and popup. */

"use strict";

/** Must match Tab Stash's STASH_ROOT in src/model/bookmarks.ts (including
 * capitalization) so both extensions operate on the same folder. */
const STASH_ROOT_NAME = "Tab Stash";

const DEFAULT_SETTINGS = {
  // Master switch. When paused, the periodic sweep does nothing.
  paused: false,
  // A tab must have been inactive at least this long before it is stashed.
  idleMinutes: 20,
  // Tabs are only stashed while more than this many tabs are open, and never
  // below this count.
  minTabs: 10,
  // If true, minTabs applies to the total across all windows; otherwise it
  // applies to each window separately.
  countAllWindows: false,
  // If true, tabs in Firefox tab groups count toward their window's total
  // (the cap applies across all groups). If false, each tab group is capped
  // separately: it keeps its own minTabs most recently used tabs, and
  // ungrouped tabs are counted per window (or globally) as usual.
  countAllGroups: true,
  skipPinned: true,
  skipAudible: true,
  // Skip creating a bookmark when the URL is already saved somewhere under
  // the Tab Stash root (the tab is still closed).
  dedupe: true,
  // Reuse the most recent unnamed "saved-..." folder if it is newer than
  // this; otherwise start a new one. (Tab Stash's own new_folder_timeout_min
  // is 5, but auto-stashing trickles tabs over time, so a longer window
  // avoids creating a folder per tab.)
  groupingMinutes: 60,
  // One pattern per line. A tab whose URL contains a pattern (case
  // insensitive, "*" matches anything) is never stashed.
  whitelist: "",
};

/** Load the stored settings, filling in defaults for anything missing.
 * @returns {Promise<object>} An object with every key of DEFAULT_SETTINGS. */
async function getSettings() {
  const stored = (await browser.storage.local.get("settings")).settings || {};
  return {...DEFAULT_SETTINGS, ...stored};
}

/** Store the settings, replacing whatever was saved before.
 * @param {object} settings A complete settings object.
 * @returns {Promise<void>} */
async function saveSettings(settings) {
  await browser.storage.local.set({settings});
}

/** Name for an unnamed stash folder. Same convention as Tab Stash's
 * genDefaultFolderName().
 * @param {Date} date
 * @returns {string} "saved-<ISO timestamp>". */
function genDefaultFolderName(date) {
  return `saved-${date.toISOString()}`;
}

/** Recognize an unnamed stash folder. Same parser as Tab Stash's
 * getDefaultFolderNameISODate().
 * @param {string} name A bookmark folder title.
 * @returns {string|null} The ISO timestamp if the title is exactly a
 *   default "saved-..." name, otherwise null. */
function getDefaultFolderNameISODate(name) {
  const m = name.match(/^saved-([-0-9:.T]+Z)$/);
  return m ? m[1] : null;
}

/** Firefox reader view wraps the real URL; unwrap it before bookmarking.
 * @param {string} url
 * @returns {string} The article URL for an about:reader URL, otherwise the
 *   input unchanged. */
function unwrapUrl(url) {
  if (url && url.startsWith("about:reader?")) {
    const m = url.match(/[?&]url=([^&]+)/);
    if (m) {
      try {
        return decodeURIComponent(m[1]);
      } catch (e) {
        return url;
      }
    }
  }
  return url;
}

/** Whether a URL is worth bookmarking: a valid http, https, ftp or file URL
 * (not about:, extension pages, etc.).
 * @param {string} url
 * @returns {boolean} */
function isStashableUrl(url) {
  if (!url) return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    return false;
  }
  return ["http:", "https:", "ftp:", "file:"].includes(parsed.protocol);
}

/** Compile the whitelist setting into matchers.
 * @param {string} text One pattern per line; blank lines are ignored.
 * @returns {RegExp[]} One case-insensitive regex per pattern, matching the
 *   pattern anywhere in a URL with "*" as a wildcard. */
function parseWhitelist(text) {
  return (text || "")
    .split("\n")
    .map(l => l.trim())
    .filter(l => l.length > 0)
    .map(pattern => {
      // Substring match with "*" wildcards, case insensitive.
      const re = pattern
        .split("*")
        .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*");
      return new RegExp(re, "i");
    });
}

/** Whether a URL matches any whitelist pattern.
 * @param {string} url
 * @param {RegExp[]} regexes As returned by parseWhitelist().
 * @returns {boolean} */
function isWhitelisted(url, regexes) {
  return regexes.some(re => re.test(url));
}
