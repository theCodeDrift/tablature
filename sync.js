// Pure logic for sharing each named group's tabs between machines through
// chrome.storage.sync. No chrome.* calls, so it can be tested in Node.
//
// Each machine writes only its own keys, so machines never overwrite each
// other and there is nothing to merge:
//   m:<machineId>             { name, at }                     one per machine
//   g:<machineId>:<groupKey>  { title, color, tabs: [{u, t}], more, at }
// Other machines read them and offer to open what isn't open locally.

import { isGroupable, normTitle } from "./lib.js";

// chrome.storage.sync limits: 8192 bytes per item (key + JSON value),
// 102400 bytes in all. Stay under both with some room for rules and settings.
export const ITEM_LIMIT = 8000;
export const TOTAL_BUDGET = 92000;
export const MAX_TABS = 50;
export const TITLE_MAX = 80;
export const STALE_DAYS = 30;

export const machineKey = (id) => `m:${id}`;
export const groupPrefix = (id) => `g:${id}:`;
export const groupKey = (id, title) => `${groupPrefix(id)}${normTitle(title).slice(0, 60)}`;

// Size chrome.storage.sync charges for one item.
export function itemBytes(key, value) {
  return new TextEncoder().encode(key + JSON.stringify(value)).length;
}

// Two tabs are the same page if only the #fragment differs.
export function urlKey(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.href;
  } catch {
    return url;
  }
}

// tabs: [{ url, title, groupId, windowId, index }]
// groups: [{ id, title, color }]
// Returns Map normTitle -> { title, color, tabs: [{ u, t }] }: every titled
// group, same-name groups across windows combined, duplicate pages dropped.
export function collectGroups(tabs, groups) {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const out = new Map();
  const sorted = [...tabs].sort((a, b) => a.windowId - b.windowId || a.index - b.index);
  for (const tab of sorted) {
    const g = byId.get(tab.groupId);
    const name = normTitle(g?.title);
    if (!name || !isGroupable(tab.url)) continue;
    if (!out.has(name)) out.set(name, { title: g.title.trim(), color: g.color, tabs: [], seen: new Set() });
    const entry = out.get(name);
    const k = urlKey(tab.url);
    if (entry.seen.has(k)) continue;
    entry.seen.add(k);
    entry.tabs.push({ u: tab.url, t: (tab.title ?? "").slice(0, TITLE_MAX) });
  }
  for (const entry of out.values()) delete entry.seen;
  return out;
}

// Shrink one group's value until its item fits: keep at most maxTabs, then
// drop tabs from the end. `more` counts what was left out.
export function fitGroup(key, group, at, maxTabs = MAX_TABS) {
  let tabs = group.tabs.slice(0, maxTabs);
  const value = () => ({ title: group.title, color: group.color, tabs, more: group.tabs.length - tabs.length, at });
  while (tabs.length && itemBytes(key, value()) > ITEM_LIMIT) {
    tabs = tabs.slice(0, Math.max(0, Math.floor(tabs.length * 0.8)));
  }
  return value();
}

// Builds this machine's items. `othersBytes` is what everything else in sync
// storage already uses; the tab cap is lowered until the whole lot fits.
export function buildItems(machineId, name, groups, at, othersBytes = 0) {
  for (let cap = MAX_TABS; ; cap = Math.floor(cap / 2)) {
    const items = { [machineKey(machineId)]: { name, at } };
    for (const g of groups.values()) {
      const key = groupKey(machineId, g.title);
      items[key] = fitGroup(key, g, at, cap);
    }
    const total = Object.entries(items).reduce((n, [k, v]) => n + itemBytes(k, v), 0);
    if (othersBytes + total <= TOTAL_BUDGET || cap <= 1) return items;
  }
}

// Compares what this machine has in sync storage with what it should have.
// Values carry a timestamp, so equality ignores `at`. Returns the keys to set
// (null when nothing changed) and the keys to remove.
export function planWrite(machineId, stored, next, now, heartbeatMs = 86400000) {
  const strip = (v) => {
    if (!v) return v;
    const { at, ...rest } = v;
    return JSON.stringify(rest);
  };
  const mine = Object.keys(stored).filter((k) => k.startsWith(groupPrefix(machineId)));
  const remove = mine.filter((k) => !(k in next));
  const set = {};
  for (const [k, v] of Object.entries(next)) {
    if (k === machineKey(machineId)) continue;
    if (strip(stored[k]) !== strip(v)) set[k] = v;
  }
  const meta = stored[machineKey(machineId)];
  const metaKey = machineKey(machineId);
  // Touch the machine record whenever anything changes, and at least daily,
  // so other machines can tell a live machine from one that is gone.
  if (Object.keys(set).length || remove.length || strip(meta) !== strip(next[metaKey]) || !meta || now - meta.at > heartbeatMs) {
    set[metaKey] = next[metaKey];
  }
  return { set: Object.keys(set).length ? set : null, remove };
}

// Reads every machine out of a full sync-storage dump.
// Returns { machines: [{ id, name, at, groups: [{ key, title, color, tabs, more }] }],
//           stale: [keys of machines unseen for STALE_DAYS, and orphaned groups] }
export function readMachines(all, myId, now) {
  const machines = new Map();
  const stale = [];
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith("m:")) {
      const id = k.slice(2);
      if (!machines.has(id)) machines.set(id, { id, groups: [] });
      Object.assign(machines.get(id), { name: v?.name || id, at: v?.at ?? 0, meta: true });
    }
  }
  for (const [k, v] of Object.entries(all)) {
    if (!k.startsWith("g:")) continue;
    const id = k.slice(2, k.indexOf(":", 2));
    const m = machines.get(id);
    if (!m) {
      if (id !== myId) stale.push(k); // no machine record: left behind
      continue;
    }
    m.groups.push({ key: k, ...v });
  }
  const cutoff = now - STALE_DAYS * 86400000;
  const out = [];
  for (const m of machines.values()) {
    if (m.id !== myId && m.at < cutoff) {
      stale.push(machineKey(m.id), ...m.groups.map((g) => g.key));
      continue;
    }
    m.groups.sort((a, b) => a.title.localeCompare(b.title));
    out.push(m);
  }
  out.sort((a, b) => b.at - a.at);
  return { machines: out, stale };
}

// For each of another machine's groups, the tabs not open anywhere here.
// localUrls: iterable of URLs open on this machine.
export function missingHere(machine, localUrls) {
  const open = new Set([...localUrls].map(urlKey));
  return machine.groups
    .map((g) => ({ ...g, missing: g.tabs.filter((t) => !open.has(urlKey(t.u))) }))
    .filter((g) => g.missing.length);
}
