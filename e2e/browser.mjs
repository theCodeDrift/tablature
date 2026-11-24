// Loads the extension unpacked in Playwright's Chromium and checks its behavior
// through the chrome.* APIs. Every http(s) request is answered locally, so it
// needs no network.
//
//   npx playwright install chromium   (once)
//   npm run test:browser
//
// CHROME=/path/to/chrome uses a specific Chromium build instead.
import { chromium } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXT = process.argv[2] ?? path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "tablature-profile-"));
const ctx = await chromium.launchPersistentContext(userDir, {
  channel: "chromium",
  headless: true,
  executablePath: process.env.CHROME || undefined,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
await ctx.route(/^https?:/, (r) =>
  r.fulfill({ contentType: "text/html", body: `<title>${r.request().url()}</title><body>hi</body>` }),
);

let sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
const extId = sw.url().split("/")[2];
const ev = (fn, arg) => sw.evaluate(fn, arg);

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push(["PASS", name]);
  } catch (e) {
    results.push(["FAIL", name, e.message]);
  }
}
async function until(desc, pred, ms = 6000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await pred();
    if (last === true) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out: ${desc}; last=${JSON.stringify(last)}`);
}
// Snapshot: per window, ordered strip of {url, group title, pinned}
const snap = () =>
  ev(async () => {
    const groups = new Map((await chrome.tabGroups.query({})).map((g) => [g.id, g]));
    const wins = await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] });
    return wins.map((w) =>
      w.tabs
        .sort((a, b) => a.index - b.index)
        .map((t) => ({
          id: t.id,
          url: t.url || t.pendingUrl,
          g: t.groupId === -1 ? null : groups.get(t.groupId)?.title ?? "?",
          gid: t.groupId,
          pinned: t.pinned,
          win: w.id,
        })),
    );
  });
const allTabs = async () => (await snap()).flat();
const groupOf = async (frag) => (await allTabs()).find((t) => t.url?.includes(frag))?.g;
const groupCount = (title, windowId) =>
  ev(
    async ([title, windowId]) =>
      (await chrome.tabGroups.query(windowId ? { windowId } : {})).filter(
        (g) => g.title.trim().toLowerCase() === title,
      ).length,
    [title, windowId],
  );
const open = async (url, extra = {}) => ev(async ([url, extra]) => (await chrome.tabs.create({ url, ...extra })).id, [url, extra]);
const setSync = (obj) => ev((o) => chrome.storage.sync.set(o), obj);

const RULES = [
  { group: "social", color: "blue", pattern: "*://*.bsky.app/*" },
  { group: "social", color: "blue", pattern: "*://x.com/*" },
  { group: "dev", color: "green", pattern: "*://github.com/*" },
];

await check("extension ID is pinned by the manifest key, so sync works across machines", async () => {
  if (extId !== "efjdfbahfkmmadlabjpogbmecbidgbmo") throw new Error(extId);
});

// 1. Tabs open before rules exist get sorted when rules are saved.
await open("https://github.com/a");
await open("https://bsky.app/b"); // *://*.bsky.app/* needs a subdomain, so this stays out
await open("https://www.bsky.app/c");
await open("https://example.com/");
await new Promise((r) => setTimeout(r, 800));
await check("no rules: nothing grouped", async () => {
  const t = await allTabs();
  if (t.some((x) => x.g)) throw new Error(JSON.stringify(t));
});
await setSync({ rules: RULES });
await check("rule save sorts already-open tabs", async () => {
  await until("github→dev, www.bsky→social", async () =>
    (await groupOf("github.com/a")) === "dev" && (await groupOf("www.bsky.app/c")) === "social" ? true : await allTabs(),
  );
  if ((await groupOf("example.com")) !== null) throw new Error("example.com got grouped");
});
await check("group color applied", async () => {
  const c = await ev(async () => (await chrome.tabGroups.query({ title: "dev" }))[0]?.color);
  if (c !== "green") throw new Error(c);
});

// 2. New tabs and navigation.
await check("new tab joins existing group (no second group)", async () => {
  await open("https://x.com/home");
  await until("x.com→social", async () => ((await groupOf("x.com/home")) === "social" ? true : await allTabs()));
  if ((await groupCount("social")) !== 1) throw new Error("count " + (await groupCount("social")));
});
await check("navigating an ungrouped tab regroups it", async () => {
  const id = (await allTabs()).find((t) => t.url.includes("example.com")).id;
  await ev((id) => chrome.tabs.update(id, { url: "https://github.com/nav" }), id);
  await until("nav→dev", async () => ((await groupOf("github.com/nav")) === "dev" ? true : await allTabs()));
});
await check("SPA pushState navigation regroups", async () => {
  const page = await ctx.newPage();
  await page.goto("https://example.org/start");
  await new Promise((r) => setTimeout(r, 600));
  // pushState can only change path on same origin, so use a rule on a path
  await setSync({ rules: [...RULES, { group: "docs", color: "", pattern: "*://example.org/docs/*" }] });
  await new Promise((r) => setTimeout(r, 600));
  if ((await groupOf("example.org/start")) !== null) throw new Error("grouped too early");
  await page.evaluate(() => history.pushState({}, "", "/docs/x"));
  await until("docs group", async () => ((await groupOf("example.org/docs/x")) === "docs" ? true : await allTabs()));
});

// 3. Duplicate same-name groups merge.
await check("same-name groups merge (case/space-insensitive)", async () => {
  const a = await open("https://example.net/1");
  const b = await open("https://example.net/2");
  await ev(async ([a, b]) => {
    const g1 = await chrome.tabs.group({ tabIds: [a] });
    await chrome.tabGroups.update(g1, { title: " Social " });
    const g2 = await chrome.tabs.group({ tabIds: [b] });
    await chrome.tabGroups.update(g2, { title: "SOCIAL" });
  }, [a, b]);
  await until("one social group", async () => ((await groupCount("social")) === 1 ? true : await allTabs()));
  const t = await allTabs();
  const sid = t.find((x) => x.url.includes("x.com")).gid;
  if (!t.filter((x) => x.url.includes("example.net")).every((x) => x.gid === sid)) throw new Error(JSON.stringify(t));
});

// 4. Order: ruled groups right after pinned tabs, in rule order.
await check("ruled groups sit after pinned tabs, in rule order", async () => {
  await open("https://pinned.test/", { pinned: true });
  await setSync({ rules: [...RULES, { group: "docs", color: "", pattern: "*://example.org/docs/*" }], groupsToTop: true, _bump: Date.now() });
  await until("order", async () => {
    const t = (await snap())[0];
    const seq = [];
    for (const x of t) if (seq[seq.length - 1] !== (x.pinned ? "PIN" : x.g ?? "-")) seq.push(x.pinned ? "PIN" : x.g ?? "-");
    const want = ["PIN", "social", "dev", "docs"];
    return want.every((w, i) => seq[i] === w) ? true : seq;
  });
});

// 5. Manual moves stick.
await check("tab dragged out of its group by hand stays out", async () => {
  const id = (await allTabs()).find((t) => t.url.includes("github.com/a")).id;
  // Simulate the user: ungroup from a page context (not the extension's own move).
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${extId}/options.html`);
  await page.evaluate((id) => chrome.tabs.ungroup(id), id);
  await new Promise((r) => setTimeout(r, 1200));
  await ev((id) => chrome.tabs.update(id, { url: "https://github.com/a2" }), id);
  await new Promise((r) => setTimeout(r, 1500));
  const g = (await allTabs()).find((t) => t.id === id).g;
  if (g !== null) throw new Error("regrouped into " + g);
  await page.close();
});
await check("'Forget manual moves' puts it back", async () => {
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${extId}/options.html`);
  // Closing tabs while the clear runs used to write the old list back.
  await page.evaluate(async () => {
    const tabs = await Promise.all([1, 2, 3, 4].map((n) => chrome.tabs.create({ url: `https://throwaway.test/${n}`, active: false })));
    await new Promise((r) => setTimeout(r, 500));
    await Promise.all([
      chrome.tabs.remove(tabs.map((t) => t.id)),
      chrome.runtime.sendMessage({ type: "clearOverrides" }),
    ]);
  });
  await page.close();
  await until("a2→dev", async () => ((await groupOf("github.com/a2")) === "dev" ? true : await allTabs()));
});

// 6. Options page UI.
await check("options page loads, saves rules, shows parse errors", async () => {
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  await page.goto(`chrome-extension://${extId}/options.html`);
  if ((await page.title()) !== "Tablature") throw new Error("title " + (await page.title()));
  await page.waitForFunction(() => document.getElementById("rules").value.includes("github"));
  await page.fill("#rules", "bad line");
  await page.click("#save");
  const e = await page.textContent("#errors");
  if (!e.includes("Line 1")) throw new Error("no error shown: " + e);
  await page.fill("#rules", "news | red | *://news.test/*\nsocial | blue | *://x.com/*");
  await page.click("#save");
  await page.waitForFunction(() => document.getElementById("status").textContent === "Saved");
  const rules = await ev(async () => (await chrome.storage.sync.get("rules")).rules);
  if (rules.length !== 2 || rules[0].group !== "news") throw new Error(JSON.stringify(rules));
  await open("https://news.test/1");
  await until("news group", async () => ((await groupOf("news.test/1")) === "news" ? true : await allTabs()));
  if (errs.length) throw new Error(errs.join(";"));
  await page.close();
});

// 7. Sharing groups between machines.
const mid = async () => (await ev(() => chrome.storage.local.get("machineId"))).machineId;
const syncAll = () => ev(() => chrome.storage.sync.get(null));

await check("this machine's named groups are written to sync storage", async () => {
  await until("snapshot written", async () => {
    const id = await mid();
    const all = await syncAll();
    const social = all[`g:${id}:social`];
    return id && all[`m:${id}`] && social?.tabs.some((t) => t.u === "https://x.com/home") ? true : Object.keys(all);
  }, 25000);
});

await check("a closed tab drops out of the synced snapshot", async () => {
  const id = await open("https://news.test/solo");
  await until("news group", async () => ((await groupOf("news.test/solo")) === "news" ? true : await allTabs()));
  await ev(() => chrome.runtime.sendMessage({ type: "snapshotNow" }).catch(() => null));
  await ev(async (id) => { await chrome.tabs.remove(id); }, id);
  const m = await mid();
  // Other news tabs may exist; only check that a removed URL leaves the snapshot.
  await until("solo gone", async () => {
    const v = (await syncAll())[`g:${m}:news`];
    return !v || !v.tabs.some((t) => t.u.includes("news.test/solo")) ? true : v;
  }, 25000);
});

const NOW = Date.now();
const LAPTOP_TABS = [
  { u: "https://reading.test/1", t: "Long read one" },
  { u: "https://reading.test/2", t: "Long read two" },
  { u: "https://x.com/home", t: "Already open here" },
];
await check("popup lists another machine's tabs that aren't open here", async () => {
  await setSync({
    "m:laptop01": { name: "Laptop", at: NOW - 5 * 60000 },
    "g:laptop01:reading": { title: "Reading", color: "purple", tabs: LAPTOP_TABS, more: 0, at: NOW },
    "m:gone0001": { name: "Old desktop", at: NOW - 45 * 86400000 },
    "g:gone0001:x": { title: "x", color: "grey", tabs: [{ u: "https://gone.test/", t: "" }], more: 0, at: 0 },
  });
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 360, height: 420 });
  await page.goto(`chrome-extension://${extId}/popup.html`);
  await page.waitForSelector(".machine");
  const text = await page.textContent("#machines");
  for (const want of ["Laptop", "Reading", "2 of 3 not open here", "Open 2"]) {
    if (!text.includes(want)) throw new Error(`missing "${want}" in: ${text}`);
  }
  if (text.includes("Old desktop")) throw new Error("stale machine shown");
  if (process.env.SCREENSHOTS) {
    await page.click(".group summary .name");
    await page.screenshot({ path: path.join(process.env.SCREENSHOTS, "popup.png") });
  }
  await page.close();
});

await check("'Open' brings them into a same-name group here, not marked as manual moves", async () => {
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${extId}/popup.html`);
  await page.click("button.open");
  await until("reading group", async () =>
    (await groupOf("reading.test/1")) === "Reading" && (await groupOf("reading.test/2")) === "Reading" ? true : await allTabs(),
  );
  await page.waitForFunction(() => document.body.textContent.includes("Everything in its groups is open here."));
  const color = await ev(async () => (await chrome.tabGroups.query({ title: "Reading" }))[0]?.color);
  if (color !== "purple") throw new Error("color " + color);
  const ids = (await allTabs()).filter((t) => t.url.includes("reading.test")).map((t) => t.id);
  const { overrides = [] } = await ev(() => chrome.storage.session.get("overrides"));
  if (ids.some((id) => overrides.includes(id))) throw new Error("restored tabs flagged as manual moves");
  await page.close();
});

await check("machines unseen for 30 days are pruned", async () => {
  await ev(() => chrome.runtime.sendMessage({ type: "snapshotNow" }).catch(() => null));
  await until("pruned", async () => {
    const all = await syncAll();
    return !("m:gone0001" in all) && !("g:gone0001:x" in all) && "m:laptop01" in all ? true : Object.keys(all);
  }, 25000);
});

await check("turning sharing off removes this machine from sync storage", async () => {
  const m = await mid();
  await ev(() => chrome.storage.local.set({ shareTabs: false }));
  await until("own keys gone", async () => {
    const keys = Object.keys(await syncAll());
    return keys.every((k) => !k.includes(m)) ? true : keys;
  }, 25000);
  await ev(() => chrome.storage.local.set({ shareTabs: true }));
  await until("own keys back", async () => (`m:${m}` in (await syncAll()) ? true : false), 25000);
});

// 8. Scopes across windows.
await check("window scope: same name in two windows stays two groups", async () => {
  await setSync({ scope: "window" });
  await ev(async () => (await chrome.windows.create({ url: "https://news.test/w2" })).id);
  await until("news in w2", async () => ((await groupOf("news.test/w2")) === "news" ? true : await allTabs()));
  if ((await groupCount("news")) !== 2) throw new Error("count " + (await groupCount("news")));
});
await check("global scope: merges across windows", async () => {
  await setSync({ scope: "global" });
  await until("one news group", async () => ((await groupCount("news")) === 1 ? true : await snap()));
});
await check("disabled: new tabs left alone", async () => {
  await setSync({ enabled: false });
  await open("https://news.test/off");
  await new Promise((r) => setTimeout(r, 1200));
  const g = await groupOf("news.test/off");
  if (g !== null) throw new Error("grouped " + g);
});

// 9. Service worker restart: logic still works after the worker is stopped.
await check("works after service worker restart", async () => {
  await setSync({ enabled: true });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("ServiceWorker.enable");
  await cdp.send("ServiceWorker.stopAllWorkers");
  await new Promise((r) => setTimeout(r, 1000));
  await page.goto(`chrome-extension://${extId}/options.html`);
  await page.evaluate(() => chrome.tabs.create({ url: "https://x.com/after-restart" }));
  await new Promise((r) => setTimeout(r, 1500));
  sw = ctx.serviceWorkers().filter((s) => s.url().includes(extId)).at(-1);
  const tabs = await page.evaluate(async () => {
    const t = (await chrome.tabs.query({ url: "https://x.com/after-restart" }))[0];
    return t.groupId === -1 ? null : (await chrome.tabGroups.get(t.groupId)).title;
  });
  if (tabs !== "social") throw new Error("group " + tabs);
});

for (const r of results) console.log(r.join("  ").slice(0, 400));
console.log(`\n${results.filter((r) => r[0] === "PASS").length}/${results.length} passed`);
await ctx.close();
fs.rmSync(userDir, { recursive: true, force: true });
process.exit(results.some((r) => r[0] === "FAIL") ? 1 : 0);
