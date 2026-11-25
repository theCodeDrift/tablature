import { groupOrder, isGroupable, matchRule, normTitle, placement, planMerges, planOrder } from "./lib.js";
import { buildItems, collectGroups, groupPrefix, itemBytes, machineKey, planWrite, readMachines } from "./sync.js";

import { isSettingsKey, loadSettings } from "./settings.js";

// Settings are read on every flush, so keep them until sync storage says
// they changed.
let settingsCache = null;

async function getSettings() {
  settingsCache ??= loadSettings();
  return settingsCache;
}

// ---------------------------------------------------------------------------
// Serialized, debounced work. Every event just marks what needs a look; one
// flush handles it all, so bursts (session restore, opening 20 tabs) settle
// in one pass and nothing races itself.

const pending = { tabs: new Set(), all: false };
let timer = null;
let chain = Promise.resolve();

function schedule(tabId) {
  scheduleSnapshot();
  if (tabId === "all") pending.all = true;
  else if (typeof tabId === "number") pending.tabs.add(tabId);
  clearTimeout(timer);
  timer = setTimeout(() => {
    chain = chain.then(flush).catch((e) => console.warn("[tablature]", e));
  }, 300);
}

async function flush() {
  const all = pending.all;
  const ids = [...pending.tabs];
  pending.all = false;
  pending.tabs.clear();

  const s = await getSettings();
  if (!s.enabled) return;

  const tabs = all
    ? await chrome.tabs.query({})
    : (await Promise.all(ids.map((id) => chrome.tabs.get(id).catch(() => null)))).filter(Boolean);

  const overrides = await getOverrides();
  for (const tab of tabs) await placeTab(tab, s, overrides);
  await mergeDuplicates(s);
  if (s.groupsToTop) await orderGroups(s);
}

// ---------------------------------------------------------------------------
// Chrome refuses edits while the user is dragging a tab. Wait and retry.

async function retry(fn, tries = 8) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const msg = String(e?.message ?? e);
      if (i >= tries || !/dragging|cannot be edited/i.test(msg)) throw e;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}

// Moves we make ourselves, so the groupId change they cause isn't mistaken
// for the user dragging a tab out of a group.
const ourMoves = new Map();

async function groupTabs(tabIds, groupId, windowId) {
  const now = Date.now();
  for (const id of tabIds) ourMoves.set(id, now);
  const opts = groupId !== undefined ? { tabIds, groupId } : { tabIds, createProperties: { windowId } };
  return retry(() => chrome.tabs.group(opts));
}

async function ungroupTabs(tabIds) {
  const now = Date.now();
  for (const id of tabIds) ourMoves.set(id, now);
  return retry(() => chrome.tabs.ungroup(tabIds));
}

// ---------------------------------------------------------------------------
// Manual overrides: a tab the user moved by hand stays where they put it.
// Kept in session storage, so they reset when Chrome restarts.

async function getOverrides() {
  const { overrides = [] } = await chrome.storage.session.get("overrides");
  return new Set(overrides);
}

// Every change is a read-modify-write, so they run one at a time. Otherwise a
// tab closing while "Forget manual moves" runs writes the old list back.
let overrideQueue = Promise.resolve();

function updateOverrides(change) {
  const run = overrideQueue.then(async () => {
    const set = await getOverrides();
    if (change(set) === false) return;
    await chrome.storage.session.set({ overrides: [...set] });
  });
  overrideQueue = run.catch((e) => console.warn("[tablature]", e));
  return run;
}

function setOverride(tabId, on) {
  return updateOverrides((set) => {
    if (set.has(tabId) === on) return false; // nothing to write
    if (on) set.add(tabId);
    else set.delete(tabId);
  });
}

async function noteGroupChange(tabId) {
  const ours = ourMoves.get(tabId);
  if (ours && Date.now() - ours < 5000) {
    ourMoves.delete(tabId);
    return;
  }
  // Chrome regroups tabs itself while restoring a session; that's not the user.
  const { startedAt = 0 } = await chrome.storage.session.get("startedAt");
  if (Date.now() - startedAt < 20000) return;
  await setOverride(tabId, true);
}

// ---------------------------------------------------------------------------

async function placeTab(tab, s, overrides) {
  if (tab.pinned || overrides.has(tab.id)) return;
  let currentTitle = null;
  if (tab.groupId !== -1) {
    const current = await chrome.tabGroups.get(tab.groupId).catch(() => null);
    if (!current) return;
    currentTitle = current.title ?? "";
  }
  const rule = placement(s.live, s.groups, tab.url || tab.pendingUrl, currentTitle);
  if (!rule) return;
  if (rule === "ungroup") {
    // Left the pages its group is for. An emptied group disappears on its own.
    await ungroupTabs([tab.id]);
    return;
  }
  const want = normTitle(rule.group);

  const query = s.scope === "global" ? {} : { windowId: tab.windowId };
  const matches = (await chrome.tabGroups.query(query)).filter((g) => normTitle(g.title) === want);
  const target = matches.find((g) => g.windowId === tab.windowId) ?? matches[0];

  if (target) {
    await groupTabs([tab.id], target.id);
  } else {
    const id = await groupTabs([tab.id], undefined, tab.windowId);
    await retry(() =>
      chrome.tabGroups.update(id, { title: rule.group, ...(rule.color ? { color: rule.color } : {}) }),
    );
  }
}

async function mergeDuplicates(s) {
  const [groups, tabs] = await Promise.all([chrome.tabGroups.query({}), chrome.tabs.query({})]);
  const firstIndex = new Map();
  for (const t of tabs) {
    if (t.groupId === -1) continue;
    const i = firstIndex.get(t.groupId);
    if (i === undefined || t.index < i) firstIndex.set(t.groupId, t.index);
  }
  groups.sort((a, b) => a.windowId - b.windowId || (firstIndex.get(a.id) ?? 0) - (firstIndex.get(b.id) ?? 0));

  for (const { keep, absorb } of planMerges(groups, s.scope)) {
    const tabIds = tabs.filter((t) => absorb.includes(t.groupId)).map((t) => t.id);
    if (tabIds.length) await groupTabs(tabIds, keep); // emptied groups vanish on their own
  }
}

async function orderGroups(s) {
  const rank = groupOrder(s.groups);
  if (!rank.size) return;
  const [groups, windows] = await Promise.all([
    chrome.tabGroups.query({}),
    chrome.windows.getAll({ populate: true, windowTypes: ["normal"] }),
  ]);
  const titles = new Map(groups.map((g) => [g.id, g.title]));

  for (const win of windows) {
    const sorted = [...win.tabs].sort((a, b) => a.index - b.index);
    const pinned = sorted.filter((t) => t.pinned).length;
    const strip = sorted
      .filter((t) => !t.pinned)
      .map((t) => ({ groupId: t.groupId, title: titles.get(t.groupId) ?? "" }));
    const desired = planOrder(strip, rank);
    if (!desired) continue;
    // Move to the front in reverse, so the first-ranked group ends up first.
    for (const id of [...desired].reverse()) {
      await retry(() => chrome.tabGroups.move(id, { index: pinned }));
    }
  }
}

// ---------------------------------------------------------------------------
// Sharing groups between machines. Each machine keeps its own snapshot of its
// named groups in chrome.storage.sync (see sync.js); the popup offers to open
// what other machines have and this one doesn't. Nothing opens or closes on
// its own.

const SNAP_DEBOUNCE = 3000;
const SNAP_MIN_INTERVAL = 15000; // sync allows ~120 writes a minute; stay far under
const RESTORE_GRACE = 20000; // let a session restore settle before snapshotting

let snapTimer = null;
let lastSnapAt = 0;
let snapChain = Promise.resolve();

async function getMachine() {
  let { machineId, machineName, shareTabs = true } = await chrome.storage.local.get(["machineId", "machineName", "shareTabs"]);
  if (!machineId) {
    machineId = crypto.randomUUID().slice(0, 8);
    await chrome.storage.local.set({ machineId });
  }
  if (!machineName) {
    const { os } = await chrome.runtime.getPlatformInfo();
    const label = { mac: "Mac", win: "Windows", linux: "Linux", cros: "ChromeOS", android: "Android" }[os] ?? os;
    machineName = `${label} ${machineId.slice(0, 4)}`;
  }
  return { machineId, machineName, shareTabs };
}

function scheduleSnapshot(delay = SNAP_DEBOUNCE) {
  clearTimeout(snapTimer);
  const wait = Math.max(delay, lastSnapAt + SNAP_MIN_INTERVAL - Date.now());
  snapTimer = setTimeout(() => {
    snapChain = snapChain.then(snapshot).catch((e) => console.warn("[tablature] snapshot", e));
  }, wait);
}

async function snapshot() {
  const { startedAt = 0 } = await chrome.storage.session.get("startedAt");
  const sinceStart = Date.now() - startedAt;
  if (sinceStart < RESTORE_GRACE) return scheduleSnapshot(RESTORE_GRACE - sinceStart);

  const { machineId, machineName, shareTabs } = await getMachine();
  const all = await chrome.storage.sync.get(null);
  const now = Date.now();
  const { stale } = readMachines(all, machineId, now);

  const mine = Object.keys(all).filter((k) => k === machineKey(machineId) || k.startsWith(groupPrefix(machineId)));
  if (!shareTabs) {
    if (mine.length || stale.length) await chrome.storage.sync.remove([...mine, ...stale]);
    lastSnapAt = Date.now();
    return;
  }

  const [tabs, groups] = await Promise.all([chrome.tabs.query({}), chrome.tabGroups.query({})]);
  const othersBytes = Object.entries(all)
    .filter(([k]) => !mine.includes(k) && !stale.includes(k))
    .reduce((n, [k, v]) => n + itemBytes(k, v), 0);
  const next = buildItems(machineId, machineName, collectGroups(tabs, groups), now, othersBytes);
  const { set, remove } = planWrite(machineId, all, next, now);

  if (remove.length || stale.length) await chrome.storage.sync.remove([...remove, ...stale]);
  if (set) await chrome.storage.sync.set(set);
  lastSnapAt = Date.now();
}

// Opens another machine's tabs here, into the same-name group in this window.
async function restore({ urls, title, color, windowId }) {
  const win = windowId ?? (await chrome.windows.getLastFocused({ windowTypes: ["normal"] })).id;
  const created = [];
  for (const url of urls.filter(isGroupable)) created.push(await chrome.tabs.create({ url, windowId: win, active: false }));
  const ids = created.map((t) => t.id);
  if (!ids.length) return 0;
  // A tab put in this group by hand on the other machine would be taken
  // straight back out of it here; treat it as the manual move it was there.
  const s = await getSettings();
  const handPlaced = created.filter((t) => placement(s.live, s.groups, t.url || t.pendingUrl, title) === "ungroup");
  if (handPlaced.length) await updateOverrides((set) => handPlaced.forEach((t) => set.add(t.id)));
  const existing = (await chrome.tabGroups.query({ windowId: win })).find((g) => normTitle(g.title) === normTitle(title));
  if (existing) {
    await groupTabs(ids, existing.id);
  } else {
    const id = await groupTabs(ids, undefined, win);
    await retry(() => chrome.tabGroups.update(id, { title, ...(color ? { color } : {}) }));
  }
  return ids.length;
}

// A group renamed or recolored in settings: change the open groups to match,
// so tabs don't get pulled into a new group under the new name.
async function applyGroupEdits(before = [], after = []) {
  const old = new Map(before.map((g) => [g.id, g]));
  const open = await chrome.tabGroups.query({});
  for (const g of after) {
    const was = old.get(g.id);
    if (!was || !normTitle(was.name)) continue;
    const renamed = normTitle(was.name) !== normTitle(g.name) && normTitle(g.name);
    const recolored = was.color !== g.color;
    if (!renamed && !recolored) continue;
    for (const tg of open.filter((x) => normTitle(x.title) === normTitle(was.name))) {
      await retry(() => chrome.tabGroups.update(tg.id, { ...(renamed ? { title: g.name } : {}), ...(recolored ? { color: g.color } : {}) }));
    }
  }
}

// ---------------------------------------------------------------------------
// Events. The original extension only looked at a tab once, when it was
// created; these cover everything that can change where a tab belongs.

chrome.runtime.onInstalled.addListener(({ reason }) => {
  schedule("all");
  if (reason === "install") chrome.tabs.create({ url: chrome.runtime.getURL("options.html#setup") });
}); 
chrome.runtime.onStartup.addListener(async () => {
  await chrome.storage.session.set({ startedAt: Date.now() });
  schedule("all");
});

chrome.tabs.onCreated.addListener((tab) => schedule(tab.id));
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url || info.pinned === false) schedule(tabId); // also fires for SPA pushState
  if ("groupId" in info) {
    noteGroupChange(tabId);
    scheduleSnapshot();
  }
});
chrome.tabs.onAttached.addListener((tabId) => schedule(tabId)); // dragged to another window
chrome.tabs.onRemoved.addListener((tabId) => {
  scheduleSnapshot();
  ourMoves.delete(tabId);
  setOverride(tabId, false);
});
chrome.tabs.onReplaced.addListener((added) => schedule(added)); // prerender swaps

chrome.tabGroups.onCreated.addListener(() => schedule());
chrome.tabGroups.onUpdated.addListener(() => schedule()); // restored groups get their title late
chrome.windows.onCreated.addListener(() => schedule("all"));

chrome.tabGroups.onRemoved.addListener(() => scheduleSnapshot());

chrome.storage.onChanged.addListener((changes, area) => {
  // Settings live in sync storage next to every machine's snapshots. Only a
  // settings change should re-sort everything.
  if (area === "sync" && Object.keys(changes).some(isSettingsKey)) {
    settingsCache = null;
    const g = changes.groupList;
    chain = chain
      .then(() => g && applyGroupEdits(g.oldValue, g.newValue))
      .catch((e) => console.warn("[tablature]", e));
    schedule("all");
  }
  if (area === "local" && ("shareTabs" in changes || "machineName" in changes)) scheduleSnapshot(0);
});

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type === "sweep") {
    schedule("all");
    reply({ ok: true });
  } else if (msg?.type === "restore") {
    restore(msg).then(
      (n) => reply({ ok: true, opened: n }),
      (e) => reply({ ok: false, error: String(e?.message ?? e) }),
    );
    return true;
  } else if (msg?.type === "machine") {
    getMachine().then(reply, () => reply(null));
    return true;
  } else if (msg?.type === "snapshotNow") {
    lastSnapAt = 0;
    snapChain = snapChain.then(snapshot).then(
      () => reply({ ok: true }),
      (e) => reply({ ok: false, error: String(e?.message ?? e) }),
    );
    return true;
  } else if (msg?.type === "clearOverrides") {
    updateOverrides((set) => set.clear()).then(() => {
      schedule("all");
      reply({ ok: true });
    });
    return true;
  }
});
