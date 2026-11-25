/* Test harness: launches a Firefox-family browser with a throwaway profile,
 * installs the built extension, and exposes helpers that run code inside one
 * of the extension's own pages (so it has the extension's API access).
 *
 * Nothing here touches your everyday profile: Selenium creates a temporary
 * one and deletes it when the browser quits.
 */

import {existsSync, readFileSync} from "node:fs";
import http from "node:http";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {Builder} from "selenium-webdriver";
import seleniumManager from "selenium-webdriver/common/seleniumManager.js";
import firefox from "selenium-webdriver/firefox.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = JSON.parse(
  readFileSync(path.join(ROOT, "manifest.json"), "utf8"),
);
const EXTENSION_ID = MANIFEST.browser_specific_settings.gecko.id;

/** Fixed internal UUID, so the extension's pages have a known address. */
const EXTENSION_UUID = "0b1f6a1e-5d0c-4c3e-9a55-a5c0de57a5b5";

/** Address of one of the extension's own pages in the test browser.
 * @param {string} page e.g. "popup.html".
 * @returns {string} */
export function extensionUrl(page) {
  return `moz-extension://${EXTENSION_UUID}/${page}`;
}
const CONTROL_URL = extensionUrl("options.html");

/** Browsers to try, in order, when FIREFOX_BINARY isn't set. */
const BINARY_CANDIDATES = [
  "C:\\Program Files\\Mozilla Firefox\\firefox.exe",
  "C:\\Program Files\\Firefox Developer Edition\\firefox.exe",
  "C:\\Program Files\\Zen Browser\\zen.exe",
  "/Applications/Firefox.app/Contents/MacOS/firefox",
  "/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox",
  "/Applications/Zen.app/Contents/MacOS/zen",
  "/usr/bin/firefox",
  "/usr/bin/zen-browser",
];

/** Path of the package `just test` builds.
 * @returns {string} */
export function builtPackagePath() {
  const name = MANIFEST.name.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  return path.join(
    ROOT,
    "web-ext-artifacts",
    "test",
    `${name}-${MANIFEST.version}.zip`,
  );
}

/** The browser binary to test with: $FIREFOX_BINARY, else the first installed
 * candidate.
 * @returns {string|null} null lets Selenium look for Firefox itself. */
function findBinary() {
  if (process.env.FIREFOX_BINARY) return process.env.FIREFOX_BINARY;
  return BINARY_CANDIDATES.find(p => existsSync(p)) || null;
}

/** Path to a geckodriver: $GECKODRIVER, else one Selenium Manager downloads
 * (and caches). We ask by Firefox version instead of letting Selenium inspect
 * the browser, because it can't map a fork's version (e.g. Zen 1.x) to a
 * driver.
 * @returns {string} */
function findGeckodriver() {
  if (process.env.GECKODRIVER) return process.env.GECKODRIVER;
  const minVersion = parseInt(
    MANIFEST.browser_specific_settings.gecko.strict_min_version,
    10,
  );
  return seleniumManager.binaryPaths([
    "--driver",
    "geckodriver",
    "--browser-version",
    String(minVersion),
    "--avoid-browser-download",
    "--output",
    "json",
  ]).driverPath;
}

/** Start a local web server whose pages the tests open as tabs, so no test
 * needs the network. Every path returns a small page titled after the path.
 * @returns {Promise<{url: (name: string) => string, close: () => Promise<void>}>} */
export async function startPageServer() {
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(req.url.slice(1)) || "index";
    res.writeHead(200, {"content-type": "text/html; charset=utf-8"});
    res.end(`<!doctype html><title>${name}</title><h1>${name}</h1>`);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const {port} = server.address();
  return {
    url: name => `http://127.0.0.1:${port}/${name}`,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

/** Launch the browser, install the extension and open its options page as
 * the "control tab" that all extension-side code runs in.
 * @returns {Promise<{driver: import("selenium-webdriver").WebDriver,
 *   binary: string|null}>} */
export async function launch() {
  const pkg = builtPackagePath();
  if (!existsSync(pkg)) {
    throw new Error(`${pkg} not found; run the tests with \`just test\``);
  }

  const options = new firefox.Options();
  const binary = findBinary();
  if (binary) options.setBinary(binary);
  if (!process.env.HEADFUL) options.addArguments("-headless");
  options.setPreference(
    "extensions.webextensions.uuids",
    JSON.stringify({[EXTENSION_ID]: EXTENSION_UUID}),
  );
  // Keep first-run pages and prompts out of the way.
  options.setPreference("browser.shell.checkDefaultBrowser", false);
  options.setPreference("browser.aboutwelcome.enabled", false);
  options.setPreference("datareporting.policy.dataSubmissionEnabled", false);
  options.setPreference("zen.welcome-screen.seen", true);

  const driver = await new Builder()
    .forBrowser("firefox")
    .setFirefoxOptions(options)
    .setFirefoxService(
      // System access is what lets WebDriver navigate to the extension's
      // own moz-extension:// pages.
      new firefox.ServiceBuilder(findGeckodriver()).addArguments(
        "--allow-system-access",
      ),
    )
    .build();
  try {
    await driver.manage().setTimeouts({script: 30000});
    await driver.installAddon(pkg, true);
    // Open the control page in a new tab, not the initial one: in Zen the
    // initial tab is a placeholder that extensions can't see.
    await driver.switchTo().newWindow("tab");
    await driver.get(CONTROL_URL);
  } catch (e) {
    await driver.quit();
    throw e;
  }
  return {driver, binary};
}

/** Run an async function inside the extension's options page and return its
 * result. The function is serialized, so it can't close over test variables;
 * pass them as arguments (JSON-serializable).
 * @param {import("selenium-webdriver").WebDriver} driver
 * @param {Function} fn Runs in the browser with `browser.*` available.
 * @param {...any} args
 * @returns {Promise<any>} Whatever fn resolves to. */
export async function inExtension(driver, fn, ...args) {
  const result = await driver.executeAsyncScript(
    `const done = arguments[arguments.length - 1];
     const args = Array.from(arguments).slice(0, -1);
     Promise.resolve()
       .then(() => (${fn})(...args))
       .then(
         value => done({ok: true, value}),
         error => done({ok: false, error: String(error && error.stack || error)}),
       );`,
    ...args,
  );
  if (!result.ok) throw new Error(`in extension page: ${result.error}`);
  return result.value;
}

/** Poll until check() returns a truthy value.
 * @param {() => Promise<any>} check
 * @param {{timeout?: number, interval?: number, what?: string}} [options]
 * @returns {Promise<any>} The truthy value. Throws on timeout. */
export async function waitFor(
  check,
  {timeout = 15000, interval = 250, what = "condition"} = {},
) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, interval));
  }
}
