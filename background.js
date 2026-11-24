import { groupOrder, matchRule, normTitle, planMerges, planOrder } from "./lib.js";

const DEFAULTS = {
  rules: [],
  enabled: true,
  groupsToTop: true,
  scope: "window", // "window" | "global"
};

async function getSettings() {
  return { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
}

// ---------------------------------------------------------------------------
// Serialized, debounced work. Every event just marks what needs a look; one
// flush handles it all, so bursts (session restore, opening 20 tabs) settle
// in one pass and nothing races itself.

const pending = { tabs: new Set(), all: false };
let timer = null;
let chain = Promise.resolve();

function schedule(tabId) {
  if (tabId === "all") pending.all = true;
  else if (typeof tabId === "number") pending.tabs.add(tabId);
  clearTimeout(timer);
  timer = setTimeout(() => {
    chain = chain.then(flush).catch((e) => console.warn("[tab-groups]", e));
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

// ---------------------------------------------------------------------------
// Manual overrides: a tab the user moved by hand stays where they put it.
// Kept in session storage, so they reset when Chrome restarts.

async function getOverrides() {
  const { overrides = [] } = await chrome.storage.session.get("overrides");
  return new Set(overrides);
}

async function setOverride(tabId, on) {
  const set = await getOverrides();
  if (on) set.add(tabId);
  else set.delete(tabId);
  await chrome.storage.session.set({ overrides: [...set] });
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
  const rule = matchRule(s.rules, tab.url || tab.pendingUrl);
  if (!rule) return;
  const want = normTitle(rule.group);

  if (tab.groupId !== -1) {
    const current = await chrome.tabGroups.get(tab.groupId).catch(() => null);
    if (!current) return;
    // Untitled group: most likely mid-restore and the title hasn't arrived.
    if (!normTitle(current.title)) return;
    if (normTitle(current.title) === want) return;
  }

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
  const rank = groupOrder(s.rules);
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
// Events. The original extension only looked at a tab once, when it was
// created; these cover everything that can change where a tab belongs.

chrome.runtime.onInstalled.addListener(() => schedule("all"));
chrome.runtime.onStartup.addListener(async () => {
  await chrome.storage.session.set({ startedAt: Date.now() });
  schedule("all");
});

chrome.tabs.onCreated.addListener((tab) => schedule(tab.id));
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url || info.pinned === false) schedule(tabId); // also fires for SPA pushState
  if ("groupId" in info) noteGroupChange(tabId);
});
chrome.tabs.onAttached.addListener((tabId) => schedule(tabId)); // dragged to another window
chrome.tabs.onRemoved.addListener((tabId) => {
  ourMoves.delete(tabId);
  setOverride(tabId, false);
});
chrome.tabs.onReplaced.addListener((added) => schedule(added)); // prerender swaps

chrome.tabGroups.onCreated.addListener(() => schedule());
chrome.tabGroups.onUpdated.addListener(() => schedule()); // restored groups get their title late
chrome.windows.onCreated.addListener(() => schedule("all"));

chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === "sync") schedule("all");
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type === "sweep") {
    schedule("all");
    reply({ ok: true });
  } else if (msg?.type === "clearOverrides") {
    chrome.storage.session.set({ overrides: [] }).then(() => {
      schedule("all");
      reply({ ok: true });
    });
    return true;
  }
});
