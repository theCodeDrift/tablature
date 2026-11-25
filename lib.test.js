import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkPattern, compilePattern, groupOrder, matchRule, matchTarget, migrateLegacy, packList,
  planMerges, planOrder, resolveRules, staleChunks, unpackList,
} from "./lib.js";

const m = (pattern, url, subpages = false) => compilePattern(pattern, subpages).test(matchTarget(url));

test("protocol is optional; given, it must match", () => {
  assert.ok(m("github.com", "https://github.com/"));
  assert.ok(m("github.com", "http://github.com"));
  assert.ok(m("https://github.com", "https://github.com/"));
  assert.ok(!m("https://github.com", "http://github.com/"));
  assert.ok(m("*://github.com/*", "https://github.com/a/b"));
});

test("bare domain matches www and apex; www. means only www", () => {
  assert.ok(m("github.com", "https://www.github.com/"));
  assert.ok(!m("github.com", "https://gist.github.com/"));
  assert.ok(m("www.github.com", "https://www.github.com/"));
  assert.ok(!m("www.github.com", "https://github.com/"));
  assert.ok(m("*.bsky.app", "https://bsky.app/"));
  assert.ok(m("*.bsky.app", "https://staging.bsky.app/"));
  assert.ok(!m("*.bsky.app", "https://notbsky.app/"));
  assert.ok(!m("github.com", "https://githubxcom/")); // dot is literal
});

test("subpages toggle: the page and everything under it, nothing beside it", () => {
  assert.ok(m("github.com/jakobo", "https://github.com/jakobo"));
  assert.ok(m("github.com/jakobo", "https://github.com/jakobo/"));
  assert.ok(m("github.com/jakobo/", "https://github.com/jakobo"));
  assert.ok(!m("github.com/jakobo", "https://github.com/jakobo/tablature"));
  assert.ok(m("github.com/jakobo", "https://github.com/jakobo/tablature", true));
  assert.ok(!m("github.com/jakobo", "https://github.com/jakobonew", true));
  assert.ok(!m("github.com", "https://github.com/x"));
  assert.ok(m("github.com", "https://github.com/x/y", true));
});

test("query, fragment and port are ignored unless the pattern names a port", () => {
  assert.ok(m("github.com/a", "https://github.com/a?tab=1#top"));
  assert.ok(m("localhost", "http://localhost:3000/", true));
  assert.ok(m("localhost:3000", "http://localhost:3000/x", true));
  assert.ok(!m("localhost:3000", "http://localhost:4000/x", true));
  assert.ok(m("x.com/*/status", "https://x.com/jakobo/status"));
});

test("checkPattern explains what is wrong", () => {
  assert.equal(checkPattern("github.com"), "");
  assert.ok(checkPattern(""));
  assert.ok(checkPattern("git hub.com"));
  assert.ok(checkPattern("https:///path"));
});

const groups = [
  { id: "g1", name: "social", color: "blue" },
  { id: "g2", name: "dev", color: "green" },
  { id: "g3", name: "", color: "red" },
];
const rules = [
  { id: "r1", pattern: "bsky.app", group: "g1", subpages: true, enabled: true },
  { id: "r2", pattern: "x.com", group: "g1", subpages: true, enabled: false },
  { id: "r3", pattern: "github.com", group: "g2", subpages: true, enabled: true },
  { id: "r4", pattern: "nowhere.test", group: "gone", subpages: true, enabled: true },
  { id: "r5", pattern: "unnamed.test", group: "g3", subpages: true, enabled: true },
];

test("resolveRules skips disabled rules and missing or unnamed groups; first match wins", () => {
  const live = resolveRules(groups, rules);
  assert.deepEqual(live.map((r) => r.id), ["r1", "r3"]);
  assert.equal(matchRule(live, "https://github.com/a/b?x=1")?.group, "dev");
  assert.equal(matchRule(live, "https://x.com/a"), null);
  assert.equal(matchRule(live, "chrome://newtab/"), null);
});

test("groupOrder follows the group list, deduped case-insensitively", () => {
  assert.deepEqual([...groupOrder([{ name: "social" }, { name: "Social" }, { name: "dev" }])], [["social", 0], ["dev", 1]]);
});

test("migrateLegacy turns flat rules into groups and rules that still match", () => {
  let n = 0;
  const { groups: g, rules: r } = migrateLegacy(
    [
      { group: "social", color: "blue", pattern: "*://*.bsky.app/*" },
      { group: "Social", color: "red", pattern: "*://x.com/*" },
      { group: "dev", color: "", pattern: "*://github.com/*" },
    ],
    () => `id${n++}`,
  );
  assert.deepEqual(g.map((x) => [x.name, x.color]), [["social", "blue"], ["dev", "grey"]]);
  assert.equal(r.length, 3);
  const live = resolveRules(g, r);
  assert.equal(matchRule(live, "https://x.com/home")?.group, "social");
  assert.equal(matchRule(live, "https://www.bsky.app/")?.group, "social");
  assert.equal(matchRule(live, "https://github.com/")?.group, "dev");
});

test("packList splits long lists under the item limit and round-trips", () => {
  const items = Array.from({ length: 300 }, (_, i) => ({ id: `r${i}`, pattern: `example${i}.com/some/path`, group: "g1", subpages: true, enabled: true }));
  const packed = packList("rules", items);
  assert.ok(packed["rules.n"] > 1);
  for (const [k, v] of Object.entries(packed)) assert.ok(JSON.stringify(v).length + k.length < 8192, k);
  assert.deepEqual(unpackList("rules", packed), items);
  const before = { ...packList("rules", items), "rules.9": [], "rulesx.3": [] };
  assert.deepEqual(staleChunks("rules", before, packList("rules", items.slice(0, 2))).sort(), Object.keys(before).filter((k) => /^rules\.\d+$/.test(k) && k !== "rules.0").sort());
  assert.equal(unpackList("rules", {}), null);
});

test("planMerges: per window vs global, untitled ignored", () => {
  const groups = [
    { id: 1, title: "social", windowId: 1 },
    { id: 2, title: "Social ", windowId: 1 },
    { id: 3, title: "social", windowId: 2 },
    { id: 4, title: "", windowId: 1 },
    { id: 5, title: "", windowId: 1 },
  ];
  assert.deepEqual(planMerges(groups, "window"), [{ keep: 1, absorb: [2] }]);
  assert.deepEqual(planMerges(groups, "global"), [{ keep: 1, absorb: [2, 3] }]);
});

test("planOrder puts ruled groups first in rule order", () => {
  const rank = groupOrder(groups);
  const strip = [
    { groupId: -1 },
    { groupId: 9, title: "dev" },
    { groupId: 9, title: "dev" },
    { groupId: 7, title: "other" },
    { groupId: 8, title: "social" },
  ];
  assert.deepEqual(planOrder(strip, rank), [8, 9]);
  const sorted = [{ groupId: 8, title: "social" }, { groupId: 9, title: "dev" }, { groupId: -1 }];
  assert.equal(planOrder(sorted, rank), null);
});
