/* Generates screenshots of the extension for its listing page. Run with
 * `just screenshots`, which builds the package first; the images land in
 * screenshots/.
 *
 * Like the integration tests, this drives the built extension in a real
 * browser with a throwaway profile: it opens a set of tabs, lets the
 * extension stash some of them, and then photographs the extension's own
 * pages in that state, once in the light theme and once in the dark one.
 *
 * The toolbar popup can't be photographed where it normally appears (it is
 * browser UI, outside the page), so popup.html is opened in a tab and only
 * its 320px-wide body is captured. The options page is captured at about the
 * width it has inside the Add-ons Manager.
 */

import {mkdir, writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {By} from "selenium-webdriver";

import {
  extensionUrl,
  inExtension,
  launch,
  startPageServer,
  waitFor,
} from "./harness.mjs";

const OUT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "screenshots",
);

/** Device pixels per CSS pixel, so the images stay sharp when scaled. */
const SCALE = 2;
/** Width of the options page inside the Add-ons Manager, roughly. */
const OPTIONS_WIDTH_PX = 680;

/** Titles of the tabs to open, least recently used first. The first ones
 * end up in the "Recently stashed" list, the last ones stay open. */
const TAB_TITLES = [
  "Sourdough starter troubleshooting - The Bread Shelf",
  "Flights to Lisbon in May - Farefinder",
  "CSS grid-template-areas - Web Docs",
  "How do heat pumps work? - Home Energy Guide",
  "Trail map: Cascade Loop - Hike Planner",
  "Array.prototype.toSorted() - Web Docs",
  "Review: five mechanical keyboards under $100",
  "Beginner's guide to container gardening",
  "City council meeting notes, March",
  "Understanding the borrow checker - Rust Notes",
  "Weeknight dal recipe - The Bread Shelf",
  "Quarterly planning - Team Wiki",
  "Inbox - Mail",
  "Project board - Tracker",
];
/** How many tabs the seeding sweep leaves open. */
const SEED_MIN_TABS = 6;
/** How many of TAB_TITLES must be stashed before the pictures are taken. */
const SEED_STASHED = 8;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Merge overrides into the stored settings (one write, so one sweep).
 * @returns {Promise<void>} */
function configure(driver, overrides) {
  return inExtension(
    driver,
    async o => saveSettings({...(await getSettings()), ...o}),
    overrides,
  );
}

/** Save a picture of one element of the current page.
 * @param {string} selector CSS selector of the element.
 * @param {string} name File name inside screenshots/.
 * @returns {Promise<void>} */
async function capture(driver, selector, name) {
  const element = await driver.findElement(By.css(selector));
  const png = Buffer.from(await element.takeScreenshot(true), "base64");
  await writeFile(path.join(OUT_DIR, name), png);
  console.log(`wrote ${path.join(OUT_DIR, name)}`);
}

/** Open the tabs and let the extension stash the oldest ones, then restore
 * everyday settings so the popup shows a realistic "next to be stashed"
 * list.
 * @returns {Promise<void>} */
async function seed(driver, server) {
  await inExtension(
    driver,
    async urls => {
      for (const url of urls) {
        await browser.tabs.create({url, active: false});
        // Distinct lastAccessed times give a well-defined stash order.
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    },
    TAB_TITLES.map(server.url),
  );
  await waitFor(
    () =>
      inExtension(driver, async () =>
        (await browser.tabs.query({url: "http://127.0.0.1/*"})).every(
          t => t.status === "complete",
        ),
      ),
    {what: "tabs to load"},
  );

  // An idle threshold of 0 stashes the excess tabs right away.
  await configure(driver, {idleMinutes: 0, minTabs: SEED_MIN_TABS});
  await waitFor(
    () =>
      inExtension(driver, async n => {
        const status = await browser.runtime.sendMessage({type: "getStatus"});
        return status.recent.length >= n;
      }, SEED_STASHED),
    {what: "tabs to be stashed"},
  );
  await sleep(1500);

  await configure(driver, {
    idleMinutes: 20,
    minTabs: 3,
    whitelist: "mail.example.com\n*calendar*",
  });
  await sleep(1500);
}

/** Photograph the popup (normal and paused) and the options page.
 * @param {string} suffix "" or "-dark", appended to each file name.
 * @returns {Promise<void>} */
async function shoot(driver, suffix) {
  const control = await driver.getWindowHandle();

  // Options page: reload it so the form shows the seeded settings.
  await driver.navigate().refresh();
  await waitFor(
    () =>
      driver.executeScript(
        "return document.getElementById('idleMinutes').value === '20'",
      ),
    {what: "the options page to load its settings"},
  );
  await driver.executeScript(
    "document.documentElement.style.width = arguments[0] + 'px'",
    OPTIONS_WIDTH_PX,
  );
  await capture(driver, "html", `options${suffix}.png`);

  // Popup, in a tab of its own so the control tab keeps working.
  await driver.switchTo().newWindow("tab");
  await driver.get(extensionUrl("popup.html"));
  await waitFor(
    () =>
      driver.executeScript(
        `return document.querySelectorAll("#upcoming li").length === 3 &&
           document.querySelectorAll("#recent li").length >= arguments[0]`,
        SEED_STASHED,
      ),
    {what: "the popup to render"},
  );
  await capture(driver, "body", `popup${suffix}.png`);

  await driver.findElement(By.id("pauseBtn")).click();
  await waitFor(
    () =>
      driver.executeScript(
        "return document.getElementById('pauseBtn').dataset.paused === '1'",
      ),
    {what: "the popup to show it is paused"},
  );
  await capture(driver, "body", `popup-paused${suffix}.png`);

  await driver.close();
  await driver.switchTo().window(control);
}

await mkdir(OUT_DIR, {recursive: true});
const server = await startPageServer();
try {
  for (const [suffix, override] of [["", 1], ["-dark", 0]]) {
    const {driver} = await launch({
      prefs: {
        "layout.css.devPixelsPerPx": String(SCALE),
        // 0 = dark, 1 = light, for web content and extension pages.
        "layout.css.prefers-color-scheme.content-override": override,
      },
    });
    try {
      // Tall enough that neither page has to scroll: an element's picture
      // only includes what fits in the window.
      await driver.manage().window().setRect({width: 1000, height: 1400});
      await seed(driver, server);
      await shoot(driver, suffix);
    } finally {
      await driver.quit();
    }
  }
} finally {
  await server.close();
}
