// Builds dist/tablature-<version>.zip with only the files the extension needs.
// Run: npm run package  (needs python3 for zipping)
//
// With --store it builds dist/tablature-<version>-store.zip for the Chrome Web
// Store instead: the store refuses a manifest with a "key" (it assigns its own
// ID), and the README isn't needed.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const files = [
  "manifest.json", "background.js", "lib.js", "sync.js", "settings.js",
  "options.html", "options.css", "options.js", "popup.html", "popup.css", "popup.js",
  "icons/icon16.png", "icons/icon32.png", "icons/icon48.png", "icons/icon128.png",
  "README.md",
];
for (const f of files) if (!fs.existsSync(path.join(root, f))) throw new Error(`missing ${f}`);
const store = process.argv.includes("--store");
fs.mkdirSync(path.join(root, "dist"), { recursive: true });
const out = path.join("dist", `tablature-${version}${store ? "-store" : ""}.zip`);
fs.rmSync(path.join(root, out), { force: true });

// Each entry is [name in the zip, file on disk]. The store build gets a copy of
// the manifest without its key.
const entries = files.filter((f) => !(store && f === "README.md")).map((f) => [f, f]);
if (store) {
  const { key, ...manifest } = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tablature-store-"));
  fs.writeFileSync(path.join(tmp, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  entries[entries.findIndex(([f]) => f === "manifest.json")][1] = path.join(tmp, "manifest.json");
}
const py = "import sys, zipfile\nwith zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED) as z:\n    a = sys.argv[2:]\n    for name, src in zip(a[0::2], a[1::2]): z.write(src, name)";
execFileSync("python3", ["-c", py, out, ...entries.flat()], { cwd: root });
console.log(out);
