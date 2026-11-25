// Renders the Chrome Web Store images into store/: three 1280x800
// screenshots and the 440x280 small promo tile. The settings page and popup
// shots come from the real extension, loaded in Playwright's Chromium with
// sample groups, rules and another machine's snapshot.
//
//   npm run store:assets      (CHROME=/path/to/chrome to pick a build)
import { chromium } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "store");
fs.mkdirSync(out, { recursive: true });

const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "tablature-store-"));
const ctx = await chromium.launchPersistentContext(userDir, {
  channel: "chromium",
  headless: true,
  colorScheme: "light",
  executablePath: process.env.CHROME || undefined,
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
});
await ctx.route(/^https?:/, (r) => r.fulfill({ contentType: "text/html", body: "<title>page</title>" }));
const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
const extId = sw.url().split("/")[2];

// Sample settings and a second machine.
await sw.evaluate(async () => {
  const groups = [
    { id: "g1", name: "Work", color: "blue" },
    { id: "g2", name: "Code", color: "green" },
    { id: "g3", name: "Reading", color: "purple" },
    { id: "g4", name: "Social", color: "pink" },
  ];
  const rules = [
    ["docs.google.com", "g1"], ["calendar.google.com", "g1"], ["github.com", "g2"],
    ["*.stackoverflow.com", "g2"], ["news.ycombinator.com", "g3"], ["*.medium.com", "g3"], ["bsky.app", "g4"],
  ].map(([pattern, group], i) => ({ id: `r${i}`, pattern, group, subpages: true, enabled: true }));
  const now = Date.now();
  await chrome.storage.sync.set({
    groupList: groups,
    "rules.n": 1,
    "rules.0": rules,
    "m:laptop01": { name: "Work laptop", at: now - 4 * 60000 },
    "g:laptop01:reading": {
      title: "Reading", color: "purple", more: 0, at: now,
      tabs: [
        { u: "https://news.ycombinator.com/item?id=1", t: "Show HN: A tiny database in 500 lines" },
        { u: "https://essays.medium.com/on-tabs", t: "Why we never close our tabs" },
        { u: "https://news.ycombinator.com/item?id=2", t: "Ask HN: How do you organize research?" },
      ],
    },
    "g:laptop01:code": {
      title: "Code", color: "green", more: 0, at: now,
      tabs: [
        { u: "https://github.com/example/app/pull/42", t: "Add offline mode #42" },
        { u: "https://github.com/example/app/issues", t: "Issues · example/app" },
      ],
    },
  });
  await chrome.storage.local.set({ machineName: "Home desktop", setupDone: true });
});
await new Promise((r) => setTimeout(r, 800));

const shot = async (page, opts) => (await page.screenshot({ ...opts, type: "png" })).toString("base64");

// Settings page: the groups and rules cards, with the address tester filled in.
const opt = await ctx.newPage();
await opt.setViewportSize({ width: 760, height: 1400 });
await opt.goto(`chrome-extension://${extId}/options.html`);
await opt.waitForSelector("#groups li");
await opt.fill("#testUrl", "github.com/example/app/pull/42");
await opt.evaluate(() => document.activeElement.blur());
const cards = opt.locator("section.card:visible");
const a = await cards.nth(0).boundingBox();
const b = await cards.nth(1).boundingBox();
const settingsPng = await shot(opt, { clip: { x: a.x - 8, y: a.y - 8, width: a.width + 16, height: b.y + b.height - a.y + 16 } });
await opt.close();

// Popup.
const pop = await ctx.newPage();
await pop.setViewportSize({ width: 360, height: 600 });
await pop.goto(`chrome-extension://${extId}/popup.html`);
await pop.waitForSelector(".machine");
for (const s of await pop.$$(".group summary .name")) await s.click();
const h = await pop.evaluate(() => Math.ceil(document.querySelector("footer").getBoundingClientRect().bottom) + 8);
const popupPng = await shot(pop, { clip: { x: 0, y: 0, width: 360, height: Math.min(h, 600) } });
await pop.close();

const icon = fs.readFileSync(path.join(root, "icons", "icon.svg"), "utf8");
const css = `
  * { box-sizing: border-box; margin: 0; }
  body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; background: #111827; color: #f9fafb; }
  .frame { width: 1280px; height: 800px; display: grid; grid-template-columns: 400px 1fr; align-items: center; padding: 0 64px; gap: 48px; overflow: hidden;
           background: radial-gradient(circle at 85% 15%, #1e3a5f 0, #111827 55%); }
  .copy h1 { font-size: 44px; line-height: 1.1; font-weight: 700; letter-spacing: -0.02em; }
  .copy p { margin-top: 20px; font-size: 21px; line-height: 1.45; color: #cbd5e1; }
  .brand { display: flex; align-items: center; gap: 12px; margin-bottom: 36px; font-size: 22px; font-weight: 600; color: #e5e7eb; }
  .brand svg { width: 40px; height: 40px; }
  .shot { justify-self: center; border-radius: 14px; box-shadow: 0 30px 80px rgba(0,0,0,.55); background: #fff; overflow: hidden; }
  .shot img { display: block; }
`;
const brand = `<div class="brand">${icon.replace("<svg ", '<svg aria-hidden="true" ')}Tablature</div>`;
const frame = (title, text, visual) =>
  `<style>${css}</style><div class="frame"><div class="copy">${brand}<h1>${title}</h1><p>${text}</p></div>${visual}</div>`;

// A drawn tab strip, before and after. Chrome's tab strip isn't part of any
// page, so it can't be screenshotted from a test browser.
const COLORS = { blue: "#1a73e8", green: "#188038", purple: "#a142f4", pink: "#d01884", grey: "#5f6368" };
const tab = (label) => `<div class="tab"><i></i>${label}</div>`;
const grp = (name, color, tabs) =>
  `<div class="grp" style="--c:${COLORS[color]}"><span class="chip">${name}</span>${tabs.map(tab).join("")}</div>`;
const strip = (items) => `<div class="strip">${items.join("")}</div>`;
const stripCss = `
  .strips { display: grid; gap: 22px; width: 720px; }
  .label { font-size: 15px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: #94a3b8; margin-bottom: 8px; }
  .strip { display: flex; flex-wrap: wrap; gap: 6px 4px; align-items: center; background: #dee1e6; border-radius: 12px; padding: 10px; }
  .grp { display: flex; align-items: center; gap: 4px; padding-bottom: 3px; border-bottom: 3px solid var(--c); }
  .chip { background: var(--c); color: #fff; font-size: 13px; font-weight: 600; padding: 4px 10px; border-radius: 7px; }
  .tab { display: flex; align-items: center; gap: 6px; background: #fff; color: #3c4043; font-size: 13px; padding: 6px 10px; border-radius: 8px; white-space: nowrap; }
  .tab i { width: 12px; height: 12px; border-radius: 3px; background: #bdc1c6; }
`;
const before = strip([
  tab("Pull request #42"), grp("code", "grey", ["Issues"]), tab("Weekly plan"), grp("Code", "green", ["Stack Overflow"]),
  tab("Hacker News"), grp("Reading", "purple", ["Pull request #57"]), tab("Calendar"), tab("Bluesky"),
]);
const after = strip([
  grp("Work", "blue", ["Weekly plan", "Calendar"]),
  grp("Code", "green", ["Pull request #42", "Issues", "Stack Overflow", "Pull request #57"]),
  grp("Reading", "purple", ["Hacker News"]),
  grp("Social", "pink", ["Bluesky"]),
]);
const stripVisual = `<style>${stripCss}</style><div class="strips"><div><div class="label">Before</div>${before}</div><div><div class="label">After</div>${after}</div></div>`;

const img = (b64, w) => `<div class="shot"><img src="data:image/png;base64,${b64}" style="width:${w}px"></div>`;
const screens = [
  ["screenshot-1-strip.png", frame("One group per name", "Tabs go to the group their site belongs in, duplicates merge, and your groups line up at the front of the tab strip.", stripVisual)],
  ["screenshot-2-rules.png", frame("Rules you can read", "Type a site like github.com, pick a group. The first matching rule wins, and a tab that leaves its site leaves the group.", img(settingsPng, 620))],
  ["screenshot-3-machines.png", frame("Your groups on every computer", "See the tabs your other computers have in each group, and open them here in one click. Nothing opens or closes on its own.", img(popupPng, 400))],
];

const page = await ctx.newPage();
await page.setViewportSize({ width: 1280, height: 800 });
for (const [name, html] of screens) {
  await page.setContent(html);
  await page.waitForLoadState("networkidle");
  const over = await page.evaluate(() => [...document.querySelectorAll(".shot")].some((e) => e.getBoundingClientRect().bottom > 800));
  if (over) throw new Error(`${name}: image runs off the bottom`);
  await page.screenshot({ path: path.join(out, name) });
}

// Small promo tile.
await page.setViewportSize({ width: 440, height: 280 });
await page.setContent(`<style>${css}
  .tile { width: 440px; height: 280px; display: flex; flex-direction: column; justify-content: center; padding: 0 40px;
          background: radial-gradient(circle at 90% 10%, #1e3a5f 0, #111827 60%); }
  .tile .brand { margin-bottom: 18px; font-size: 34px; font-weight: 700; color: #fff; }
  .tile .brand svg { width: 56px; height: 56px; }
  .tile p { font-size: 20px; line-height: 1.35; color: #cbd5e1; }
</style><div class="tile">${brand}<p>Tab groups by site, one per name, on every computer.</p></div>`);
await page.screenshot({ path: path.join(out, "promo-small-440x280.png") });

await ctx.close();
fs.rmSync(userDir, { recursive: true, force: true });
console.log(fs.readdirSync(out).filter((f) => f.endsWith(".png")).map((f) => `store/${f}`).join("\n"));
