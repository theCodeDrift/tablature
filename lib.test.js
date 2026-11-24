import { test } from "node:test";
import assert from "node:assert/strict";
import { groupOrder, matchRule, parseRules, planMerges, planOrder } from "./lib.js";

const rules = [
  { group: "social", color: "blue", pattern: "*://*.bsky.app/*" },
  { group: "Social", color: "blue", pattern: "*://x.com/*" },
  { group: "dev", color: "green", pattern: "*://github.com/*" },
];

test("first match wins, wildcards only", () => {
  assert.equal(matchRule(rules, "https://x.com/jakobo")?.group, "Social");
  assert.equal(matchRule(rules, "https://github.com/a/b?x=1")?.group, "dev");
  assert.equal(matchRule(rules, "https://githubxcom/"), null); // dot is literal
  assert.equal(matchRule(rules, "chrome://newtab/"), null);
});

test("groupOrder dedupes names case-insensitively", () => {
  assert.deepEqual([...groupOrder(rules)], [["social", 0], ["dev", 1]]);
});

test("parseRules reports bad lines", () => {
  const { rules: r, errors } = parseRules("# c\nsocial | blue | *://x.com/*\nbad line\nx | mauve | *");
  assert.equal(r.length, 1);
  assert.equal(errors.length, 2);
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
  const rank = groupOrder(rules);
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
