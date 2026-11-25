// Reading and writing settings in chrome.storage.sync. Shared by the
// background worker and the options page.
//
//   groupList   [{ id, name, color }]                       front-of-strip order
//   rules.n     number of chunks, rules.0 ... [{ id, pattern, group, subpages, enabled }]
//   enabled, groupsToTop, scope
//
// 0.1 and 0.2 kept one flat `rules` array of { group, color, pattern }; it is
// migrated the first time either side reads settings.

import { migrateLegacy, packList, resolveRules, staleChunks, unpackList } from "./lib.js";

export const FLAGS = { enabled: true, groupsToTop: true, scope: "window" };

export const newId = () => crypto.randomUUID().slice(0, 8);

// Keys that are settings (as opposed to machine snapshots m:/g:).
export const isSettingsKey = (k) => k === "groupList" || k === "rules" || /^rules\.(n|\d+)$/.test(k) || k in FLAGS;

export async function loadSettings() {
  const all = await chrome.storage.sync.get(null);
  let groups = all.groupList;
  let rules = unpackList("rules", all);
  if (!groups && !rules && Array.isArray(all.rules)) {
    ({ groups, rules } = migrateLegacy(all.rules, newId));
    await saveLists(groups, rules, all);
    await chrome.storage.sync.remove("rules");
  }
  groups ??= [];
  rules ??= [];
  const flags = Object.fromEntries(Object.entries(FLAGS).map(([k, v]) => [k, all[k] ?? v]));
  return { ...flags, groups, rules, live: resolveRules(groups, rules) };
}

// Writes both lists; `all` is a current dump of sync storage, if the caller has one.
export async function saveLists(groups, rules, all) {
  const packed = packList("rules", rules);
  await chrome.storage.sync.set({ groupList: groups, ...packed });
  const stale = staleChunks("rules", all ?? (await chrome.storage.sync.get(null)), packed);
  if (stale.length) await chrome.storage.sync.remove(stale);
}
