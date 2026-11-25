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
// Writes groups and rules in the current format, from flat { group, color, pattern, subpages }.
const setRules = (list) =>
  ev(async (list) => {
    const groups = [];
    const byName = new Map();
    const rules = [];
    for (const r of list) {
      if (!byName.has(r.group)) {
        const g = { id: `g_${r.group}`, name: r.group, color: r.color || "grey" };
        byName.set(r.group, g);
        groups.push(g);
      }
      rules.push({ id: `r${rules.length}`, pattern: r.pattern, group: byName.get(r.group).id, subpages: !!r.subpages, enabled: true });
    }
    await chrome.storage.sync.set({ groupList: groups, "rules.n": 1, "rules.0": rules });
  }, list);
const sweep = async () => {
  const p = await ctx.newPage();
  await p.goto(`chrome-extension://${extId}/popup.html`);
  await p.evaluate(() => chrome.runtime.sendMessage({ type: "sweep" }));
  await p.close();
};

const RULES = [
  { group: "social", color: "blue", pattern: "*://*.bsky.app/*" },
  { group: "social", color: "blue", pattern: "*://x.com/*" },
  { group: "dev", color: "green", pattern: "*://github.com/*" },
];

await check("extension ID is pinned by the manifest key, so sync works across machines", async () => {
  if (extId !== "efjdfbahfkmmadlabjpogbmecbidgbmo") throw new Error(extId);
});

await check("installing opens the settings page at the setup steps", async () => {
  await until("setup tab", async () =>
    (await ev(async (id) => (await chrome.tabs.query({})).some((t) => (t.url || t.pendingUrl) === `chrome-extension://${id}/options.html#setup`), extId)) || "no tab",
  );
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
await setSync({ rules: RULES }); // 0.2's flat format, migrated on read
await check("rules from 0.2 are migrated to groups and rules", async () => {
  await until("migrated", async () => {
    const all = await ev(() => chrome.storage.sync.get(null));
    const names = (all.groupList ?? []).map((g) => g.name);
    return !("rules" in all) && names.join() === "social,dev" && all["rules.0"]?.length === 3 ? true : all;
  });
});
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
  const id = (await allTabs()).find((t) => t.url?.includes("example.com")).id;
  await ev((id) => chrome.tabs.update(id, { url: "https://github.com/nav" }), id);
  await until("nav→dev", async () => ((await groupOf("github.com/nav")) === "dev" ? true : await allTabs()));
});
await check("SPA pushState navigation regroups", async () => {
  const page = await ctx.newPage();
  await page.goto("https://example.org/start");
  await new Promise((r) => setTimeout(r, 600));
  // pushState can only change path on same origin, so use a rule on a path
  await setRules([...RULES, { group: "docs", color: "", pattern: "*://example.org/docs/*" }]);
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
  const sid = t.find((x) => x.url?.includes("x.com")).gid;
  if (!t.filter((x) => x.url?.includes("example.net")).every((x) => x.gid === sid)) throw new Error(JSON.stringify(t));
});

// 4. Order: ruled groups right after pinned tabs, in rule order.
await check("ruled groups sit after pinned tabs, in rule order", async () => {
  await open("https://pinned.test/", { pinned: true });
  await sweep();
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
  const id = (await allTabs()).find((t) => t.url?.includes("github.com/a")).id;
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
const optionsPage = async () => {
  const page = await ctx.newPage();
  page.errs = [];
  page.on("pageerror", (e) => page.errs.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.goto(`chrome-extension://${extId}/options.html`);
  await page.waitForSelector("#groups li");
  return page;
};
// The row in a list whose input currently holds `value` (a property, not an attribute).
const rowWith = async (page, list, input, value) => {
  const i = await page.$$eval(`${list} li ${input}`, (els, v) => els.findIndex((e) => e.value === v), value);
  if (i < 0) throw new Error(`no row with ${value}`);
  return page.locator(`${list} li`).nth(i);
};
const stored = () => ev(async () => {
  const all = await chrome.storage.sync.get(null);
  return { groups: all.groupList, rules: Array.from({ length: all["rules.n"] }, (_, i) => all[`rules.${i}`]).flat() };
});

await check("options page lists groups and rules, and setup steps until dismissed", async () => {
  const page = await optionsPage();
  if ((await page.title()) !== "Tablature") throw new Error("title " + (await page.title()));
  const groups = await page.$$eval("#groups .name", (els) => els.map((e) => e.value));
  if (groups.join() !== "social,dev,docs") throw new Error(groups.join());
  const patterns = await page.$$eval("#rules .pattern", (els) => els.map((e) => e.value));
  if (patterns.length !== 4 || patterns[3] !== "*://example.org/docs/*") throw new Error(patterns.join());
  if (await page.isHidden("#setup")) throw new Error("setup steps hidden on first visit");
  await page.click("#openSync");
  await until("sync settings tab", async () =>
    (await ev(async () => (await chrome.tabs.query({})).some((t) => (t.url || t.pendingUrl || "").startsWith("chrome://settings/syncSetup")))) || "no tab",
  );
  await page.click("#setupDone");
  await page.reload();
  await page.waitForSelector("#groups li");
  if (!(await page.isHidden("#setup"))) throw new Error("setup steps still shown after Done");
  if (page.errs.length) throw new Error(page.errs.join(";"));
  await page.close();
});

await check("add a group and a rule without typing rules text; tabs follow", async () => {
  const page = await optionsPage();
  await page.click("#addGroup");
  await page.fill("#groups li:last-child .name", "news");
  await page.press("#groups li:last-child .name", "Tab");
  await page.click("#groups li:last-child .swatch");
  await page.click('#groups li:last-child .palette button[aria-label="red"]');
  await page.click("#addRule");
  const row = "#rules li:last-child";
  await page.fill(`${row} .pattern`, "news .test");
  if (!(await page.textContent(`${row} .error`)).includes("space")) throw new Error("no error for a space");
  await page.fill(`${row} .pattern`, "news.test");
  if (!(await page.isChecked(`${row} .sub input`))) throw new Error("subpages should default on");
  await page.selectOption(`${row} select`, { label: "news" });
  await page.fill("#testUrl", "news.test/some/story");
  const result = await page.textContent("#testResult");
  if (!result.includes("news") || !result.includes("rule 5")) throw new Error("tester: " + result);
  await until("saved", async () => {
    const { groups, rules } = await stored();
    const news = groups.find((g) => g.name === "news");
    return news?.color === "red" && rules.some((r) => r.pattern === "news.test" && r.group === news.id && r.subpages) ? true : { groups, rules };
  });
  await open("https://news.test/1");
  await until("news group", async () => ((await groupOf("news.test/1")) === "news" ? true : await allTabs()));
  const c = await ev(async () => (await chrome.tabGroups.query({ title: "news" }))[0]?.color);
  if (c !== "red") throw new Error("color " + c);
  if (page.errs.length) throw new Error(page.errs.join(";"));
  await page.close();
});

await check("drag a group to the top: saved, and the tab strip follows", async () => {
  const page = await optionsPage();
  await page.dragAndDrop("#groups li:last-child .handle", "#groups li:first-child", { targetPosition: { x: 40, y: 3 } });
  await until("order saved", async () => {
    const names = (await stored()).groups.map((g) => g.name).join();
    return names === "news,social,dev,docs" ? true : names;
  });
  await until("strip order", async () => {
    const t = (await snap())[0].filter((x) => !x.pinned && x.g);
    return t[0]?.g === "news" ? true : t.map((x) => x.g);
  });
  await page.close();
});

await check("drag a rule: first match wins in the new order", async () => {
  await setRules([
    { group: "news", color: "red", pattern: "news.test", subpages: true },
    { group: "social", color: "blue", pattern: "x.com", subpages: true },
    { group: "social", color: "blue", pattern: "bsky.app", subpages: true },
    { group: "dev", color: "green", pattern: "github.com", subpages: true },
    { group: "docs", color: "grey", pattern: "example.org/docs", subpages: true },
    { group: "dev", color: "green", pattern: "x.com/dev", subpages: true },
  ]);
  const page = await optionsPage();
  await page.fill("#testUrl", "https://x.com/dev/1");
  if (!(await page.textContent("#testResult")).includes("social")) throw new Error(await page.textContent("#testResult"));
  await page.dragAndDrop("#rules li:last-child .handle", "#rules li:first-child", { targetPosition: { x: 40, y: 3 } });
  await page.waitForFunction(() => document.getElementById("testResult").textContent.includes("dev"));
  await until("rule order saved", async () => ((await stored()).rules[0].pattern === "x.com/dev" ? true : (await stored()).rules.map((r) => r.pattern)));
  await page.close();
});

await check("renaming or recoloring a group changes the open group, without a second one", async () => {
  const page = await optionsPage();
  const docs = await rowWith(page, "#groups", ".name", "docs");
  await docs.locator(".name").fill("reference");
  await docs.locator(".name").press("Tab");
  await docs.locator(".swatch").click();
  await docs.locator('.palette button[aria-label="cyan"]').click();
  await until("renamed", async () => ((await groupOf("example.org/docs/x")) === "reference" ? true : await allTabs()));
  const gs = await ev(() => chrome.tabGroups.query({}));
  if (gs.some((g) => g.title === "docs")) throw new Error("old group left behind");
  if (gs.find((g) => g.title === "reference")?.color !== "cyan") throw new Error("color not applied");
  await page.close();
});

await check("rule switch off, delete rule, delete group with its rules", async () => {
  const page = await optionsPage();
  const ruleRow = await rowWith(page, "#rules", ".pattern", "x.com/dev");
  await ruleRow.locator(".switch input").uncheck();
  await until("rule off", async () => ((await stored()).rules.find((r) => r.pattern === "x.com/dev")?.enabled === false ? true : false));
  await ruleRow.locator(".remove").click();
  const ref = await rowWith(page, "#groups", ".name", "reference");
  await ref.locator(".remove").click(); // confirm() accepted
  await until("deleted", async () => {
    const { groups, rules } = await stored();
    return !groups.some((g) => g.name === "reference") && !rules.some((r) => r.pattern === "x.com/dev" || r.pattern === "example.org/docs") ? true : { groups, rules };
  });
  if (page.errs.length) throw new Error(page.errs.join(";"));
  if (process.env.SCREENSHOTS) {
    await page.setViewportSize({ width: 820, height: 900 });
    await page.click("#showSetup");
    await page.fill("#testUrl", "github.com/jakobo/tablature");
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(process.env.SCREENSHOTS, "options.png"), fullPage: true });
  }
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
  const ids = (await allTabs()).filter((t) => t.url?.includes("reading.test")).map((t) => t.id);
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
