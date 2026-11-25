// Pure logic, no chrome.* calls, so it can be tested in Node.

export const COLORS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];

// A group's identity is its name, trimmed and case-insensitive.
export function normTitle(title) {
  return (title ?? "").trim().toLowerCase();
}

// URL patterns. Written the way people say them:
//   github.com             github.com or www.github.com, any protocol, home page only
//   github.com/jakobo      that page (a trailing slash is fine)
//   www.github.com         only the www host
//   *.bsky.app             bsky.app and any subdomain
//   https://x.com          only https
//   x.com/*/status         * matches anything, including /
// `subpages` adds everything below the path: github.com/jakobo with subpages
// also matches github.com/jakobo/tablature, never github.com/jakobonew.
// The query string and #fragment are ignored.

const esc = (s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
const wild = (s, any) => esc(s).replace(/\*/g, any);
const compiled = new Map();

export function compilePattern(pattern, subpages = false) {
  const cacheKey = `${subpages ? 1 : 0}${pattern}`;
  if (compiled.has(cacheKey)) return compiled.get(cacheKey);

  let rest = pattern.trim().replace(/[?#].*$/, "");
  let scheme = "[a-z][a-z0-9+.-]*";
  const m = rest.match(/^([a-z*][a-z0-9+.*-]*):\/\//i);
  if (m) {
    if (m[1] !== "*") scheme = wild(m[1], "[a-z0-9+.-]*");
    rest = rest.slice(m[0].length);
  }
  const slash = rest.indexOf("/");
  let host = slash === -1 ? rest : rest.slice(0, slash);
  let path = slash === -1 ? "" : rest.slice(slash);

  let hostRe;
  if (host.startsWith("*.")) hostRe = `(?:[^/]*\\.)?${wild(host.slice(2), "[^/]*")}`;
  else if (/^www\./i.test(host) || host.includes("*")) hostRe = wild(host, "[^/]*");
  else hostRe = `(?:www\\.)?${wild(host, "[^/]*")}`;
  if (!/:\d+$/.test(host)) hostRe += "(?::\\d+)?";

  path = path.replace(/\/+$/, "");
  const tail = subpages ? "(?:/.*)?" : "/?";
  const re = new RegExp(`^${scheme}://${hostRe}${wild(path, ".*")}${tail}$`, "i");
  compiled.set(cacheKey, re);
  return re;
}

// What a pattern is matched against: protocol, host and path, nothing else.
export function matchTarget(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return url;
  }
}

// Empty string if the pattern is usable, otherwise what is wrong with it.
export function checkPattern(pattern) {
  const p = (pattern ?? "").trim();
  if (!p) return "Enter a site, like github.com";
  if (/\s/.test(p)) return "No spaces";
  const host = p.replace(/^[a-z*][a-z0-9+.*-]*:\/\//i, "").split("/")[0];
  if (!host) return "Needs a site before the first /";
  return "";
}

// New-tab pages, chrome:// pages and the like are left alone.
export function isGroupable(url) {
  return typeof url === "string" && /^(https?|file):/i.test(url);
}

// groups: [{ id, name, color }] in front-of-strip order.
// rules: [{ id, pattern, group (a group id), subpages, enabled }], first match wins.
// Returns the rules that can fire, each carrying its group's name and color:
// [{ id, pattern, subpages, group: name, color }].
export function resolveRules(groups, rules) {
  const byId = new Map(groups.filter((g) => normTitle(g.name)).map((g) => [g.id, g]));
  return rules
    .filter((r) => r.enabled !== false && byId.has(r.group) && !checkPattern(r.pattern))
    .map((r) => ({ id: r.id, pattern: r.pattern, subpages: !!r.subpages, group: byId.get(r.group).name, color: byId.get(r.group).color }));
}

// First matching rule wins.
export function matchRule(rules, url) {
  if (!isGroupable(url)) return null;
  const target = matchTarget(url);
  for (const rule of rules) {
    if (rule.pattern && compilePattern(rule.pattern, rule.subpages).test(target)) return rule;
  }
  return null;
}

// Group names in order, deduplicated: the order groups are sorted into at the
// front of the tab strip. Takes [{ name }] (or resolved rules, by .group).
export function groupOrder(list) {
  const seen = new Map();
  for (const item of list) {
    const key = normTitle(item.name ?? item.group);
    if (key && !seen.has(key)) seen.set(key, seen.size);
  }
  return seen; // normTitle -> rank
}

// Turns 0.1/0.2's flat rules ([{ group, color, pattern }]) into groups and rules.
// Old patterns used * wildcards with an explicit scheme and path, which the
// new syntax still reads the same way.
export function migrateLegacy(oldRules, newId) {
  const groups = [];
  const byName = new Map();
  const rules = [];
  for (const r of oldRules ?? []) {
    const key = normTitle(r.group);
    if (!key || !r.pattern) continue;
    if (!byName.has(key)) {
      const g = { id: newId(), name: r.group.trim(), color: r.color || "grey" };
      byName.set(key, g);
      groups.push(g);
    }
    rules.push({ id: newId(), pattern: r.pattern, group: byName.get(key).id, subpages: false, enabled: true });
  }
  return { groups, rules };
}

// chrome.storage.sync caps each item at 8 KB, so long lists are stored in
// chunks: <name>.n holds the count, <name>.0, <name>.1 ... the items.
export function packList(name, items, limit = 7000) {
  const out = {};
  let chunk = [];
  let size = 2;
  let n = 0;
  for (const item of items) {
    const bytes = new TextEncoder().encode(JSON.stringify(item)).length + 1;
    if (chunk.length && size + bytes > limit) {
      out[`${name}.${n++}`] = chunk;
      chunk = [];
      size = 2;
    }
    chunk.push(item);
    size += bytes;
  }
  if (chunk.length) out[`${name}.${n++}`] = chunk;
  out[`${name}.n`] = n;
  return out;
}

export function unpackList(name, all) {
  const n = all[`${name}.n`];
  if (typeof n !== "number") return null;
  const items = [];
  for (let i = 0; i < n; i++) items.push(...(all[`${name}.${i}`] ?? []));
  return items;
}

// Keys a list used to need but no longer does after packing it again.
export function staleChunks(name, all, packed) {
  const n = packed[`${name}.n`];
  return Object.keys(all).filter((k) => k.startsWith(`${name}.`) && /^\d+$/.test(k.slice(name.length + 1)) && Number(k.slice(name.length + 1)) >= n);
}

// groups: [{ id, title, windowId }], already sorted so the one to keep comes
// first (by window, then tab-strip position). scope "window" merges same-name
// groups within each window; "global" merges across windows.
// Returns [{ keep, absorb: [ids] }] for every name that has duplicates.
export function planMerges(groups, scope = "window") {
  const byKey = new Map();
  for (const g of groups) {
    const name = normTitle(g.title);
    if (!name) continue; // untitled: probably mid-restore, wait for the title
    const key = scope === "global" ? name : `${g.windowId}\u0000${name}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(g.id);
  }
  const plans = [];
  for (const ids of byKey.values()) {
    if (ids.length > 1) plans.push({ keep: ids[0], absorb: ids.slice(1) });
  }
  return plans;
}

// tabs: one window's unpinned tabs sorted by index, [{ groupId, title }]
// (title is the group's title, ignored for groupId -1).
// rank: Map from groupOrder(). Returns the group ids that should sit at the
// front, in order, or null if the strip already starts with them in order.
export function planOrder(tabs, rank) {
  const segments = [];
  for (const t of tabs) {
    const last = segments[segments.length - 1];
    if (t.groupId !== -1 && last && last.groupId === t.groupId) continue;
    segments.push({ groupId: t.groupId, title: t.title });
  }
  const ruled = segments
    .filter((s) => s.groupId !== -1 && rank.has(normTitle(s.title)))
    .sort((a, b) => rank.get(normTitle(a.title)) - rank.get(normTitle(b.title)));
  const desired = ruled.map((s) => s.groupId);
  const current = segments.slice(0, desired.length).map((s) => s.groupId);
  const inOrder = desired.every((id, i) => current[i] === id);
  return inOrder ? null : desired;
}
