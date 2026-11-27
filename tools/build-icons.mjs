// Renders icons/icon.svg to icons/icon-<size>.png for each size the manifest
// lists. Run by `just icons` (and so by `just build` and `just test`).

import {readFile, writeFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {Resvg} from "@resvg/resvg-js";

/** Pixel sizes to render; keep in sync with "icons" in manifest.json. */
const SIZES = [16, 32, 48, 64, 96, 128];

const iconsDir = new URL("../icons/", import.meta.url);
const svg = await readFile(new URL("icon.svg", iconsDir));

for (const size of SIZES) {
  const png = new Resvg(svg, {fitTo: {mode: "width", value: size}})
    .render()
    .asPng();
  const out = new URL(`icon-${size}.png`, iconsDir);
  await writeFile(out, png);
  console.log(`wrote ${fileURLToPath(out)}`);
}
