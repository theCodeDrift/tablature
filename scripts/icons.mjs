// Renders icons/icon.svg to the PNG sizes Chrome wants. Run: node scripts/icons.mjs
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "icons");
const svg = fs.readFileSync(path.join(dir, "icon.svg"), "utf8");
const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined });
const page = await browser.newPage();
for (const size of [16, 32, 48, 128]) {
  // The 128px icon is the store and install-dialog icon: Chrome's guidelines
  // put 96px of artwork in it with 16px of transparent padding.
  const art = size === 128 ? 96 : size;
  const pad = (size - art) / 2;
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<style>*{margin:0}body{background:transparent;padding:${pad}px}svg{display:block}</style>${svg.replace("<svg ", `<svg width="${art}" height="${art}" `)}`,
  );
  await page.screenshot({ path: path.join(dir, `icon${size}.png`), omitBackground: true });
}
await browser.close();
