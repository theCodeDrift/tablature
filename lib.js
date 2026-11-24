// Pure logic, no chrome.* calls, so it can be tested in Node.

export const COLORS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];

// A group's identity is its name, trimmed and case-insensitive.
export function normTitle(title) {
  return (title ?? "").trim().toLowerCase();
}

// "*://*.github.com/*" -> RegExp. Only * is special.
export function patternToRegExp(pattern) {
  const escaped = pattern
    .trim()
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

// New-tab pages, chrome:// pages and the like are left alone.
export function isGroupable(url) {
  return typeof url === "string" && /^(https?|file):/i.test(url);
}

// First matching rule wins.
export function matchRule(rules, url) {
  if (!isGroupable(url)) return null;
  for (const rule of rules) {
    if (rule.pattern && patternToRegExp(rule.pattern).test(url)) return rule;
  }
  return null;
}

// Group names in rule order, deduplicated. This is also the order groups
// are sorted into at the front of the tab strip.
export function groupOrder(rules) {
  const seen = new Map();
  for (const rule of rules) {
    const key = normTitle(rule.group);
    if (key && !seen.has(key)) seen.set(key, seen.size);
  }
  return seen; // normTitle -> rank
}

// Rules text format, one per line:  group | color | pattern
// Color may be blank. Lines starting with # are comments.
export function parseRules(text) {
  const rules = [];
  const errors = [];
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const parts = line.split("|").map((p) => p.trim());
    if (parts.length !== 3) {
      errors.push(`Line ${i + 1}: expected "group | color | pattern"`);
      return;
    }
    const [group, color, pattern] = parts;
    if (!group || !pattern) {
      errors.push(`Line ${i + 1}: group and pattern are required`);
      return;
    }
    if (color && !COLORS.includes(color.toLowerCase())) {
      errors.push(`Line ${i + 1}: color must be one of ${COLORS.join(", ")}`);
      return;
    }
    rules.push({ group, color: color.toLowerCase(), pattern });
  });
  return { rules, errors };
}

export function formatRules(rules) {
  return rules.map((r) => `${r.group} | ${r.color ?? ""} | ${r.pattern}`).join("\n");
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
