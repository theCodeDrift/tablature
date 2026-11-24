// Builds dist/tablature-<version>.zip with only the files the extension needs.
// Run: npm run package  (needs python3 for zipping)
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const files = [
  "manifest.json", "background.js", "lib.js", "sync.js",
  "options.html", "options.js", "popup.html", "popup.css", "popup.js",
  "icons/icon16.png", "icons/icon32.png", "icons/icon48.png", "icons/icon128.png",
  "README.md",
];
for (const f of files) if (!fs.existsSync(path.join(root, f))) throw new Error(`missing ${f}`);
fs.mkdirSync(path.join(root, "dist"), { recursive: true });
const out = path.join("dist", `tablature-${version}.zip`);
fs.rmSync(path.join(root, out), { force: true });
const py = "import sys, zipfile\nwith zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED) as z:\n    for f in sys.argv[2:]: z.write(f, f)";
execFileSync("python3", ["-c", py, out, ...files], { cwd: root });
console.log(out);
