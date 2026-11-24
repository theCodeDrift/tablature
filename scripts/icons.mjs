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
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>*{margin:0}body{background:transparent}</style>${svg.replace("<svg ", `<svg width="${size}" height="${size}" `)}`);
  await page.screenshot({ path: path.join(dir, `icon${size}.png`), omitBackground: true });
}
await browser.close();
