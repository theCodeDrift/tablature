import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ITEM_LIMIT, TOTAL_BUDGET, buildItems, collectGroups, fitGroup, groupKey, itemBytes,
  machineKey, missingHere, planWrite, readMachines, urlKey,
} from "./sync.js";

const DAY = 86400000;

test("collectGroups: titled groups only, same name combined across windows, duplicates dropped", () => {
  const groups = [
    { id: 1, title: "Social", color: "blue" },
    { id: 2, title: " social ", color: "red" },
    { id: 3, title: "", color: "grey" },
  ];
  const tabs = [
    { url: "https://x.com/a", title: "A", groupId: 1, windowId: 1, index: 0 },
    { url: "https://x.com/a#top", title: "A again", groupId: 2, windowId: 2, index: 0 },
    { url: "https://bsky.app/b", title: "B", groupId: 2, windowId: 2, index: 1 },
    { url: "chrome://newtab/", title: "New", groupId: 1, windowId: 1, index: 1 },
    { url: "https://untitled.test/", title: "U", groupId: 3, windowId: 1, index: 2 },
    { url: "https://loose.test/", title: "L", groupId: -1, windowId: 1, index: 3 },
  ];
  const out = collectGroups(tabs, groups);
  assert.deepEqual([...out.keys()], ["social"]);
  assert.equal(out.get("social").title, "Social");
  assert.deepEqual(out.get("social").tabs.map((t) => t.u), ["https://x.com/a", "https://bsky.app/b"]);
});

test("fitGroup keeps each item under the per-item limit and counts what it dropped", () => {
  const tabs = Array.from({ length: 200 }, (_, i) => ({ u: `https://example.com/${"x".repeat(150)}/${i}`, t: "t".repeat(80) }));
  const key = groupKey("abcd1234", "big");
  const v = fitGroup(key, { title: "big", color: "blue", tabs }, 1);
  assert.ok(itemBytes(key, v) <= ITEM_LIMIT);
  assert.ok(v.tabs.length > 0 && v.tabs.length <= 50);
  assert.equal(v.tabs.length + v.more, 200);
});

test("buildItems lowers the tab cap when the whole sync store would overflow", () => {
  const tabs = Array.from({ length: 50 }, (_, i) => ({ u: `https://example.com/${"y".repeat(80)}/${i}`, t: "title" }));
  const groups = new Map(Array.from({ length: 12 }, (_, i) => [`g${i}`, { title: `g${i}`, color: "red", tabs }]));
  const items = buildItems("m1", "Laptop", groups, 1, 30000);
  const total = Object.entries(items).reduce((n, [k, v]) => n + itemBytes(k, v), 0);
  assert.ok(30000 + total <= TOTAL_BUDGET, `total ${total}`);
  assert.deepEqual(items[machineKey("m1")], { name: "Laptop", at: 1 });
});

test("planWrite: nothing to do when only timestamps differ, removes closed groups", () => {
  const g = { title: "dev", color: "green", tabs: [{ u: "https://github.com/", t: "GH" }], more: 0 };
  const stored = {
    [machineKey("m1")]: { name: "Laptop", at: 100 },
    [groupKey("m1", "dev")]: { ...g, at: 100 },
    [groupKey("m1", "old")]: { ...g, title: "old", at: 100 },
    [groupKey("m2", "dev")]: { ...g, at: 100 }, // another machine's: never touched
  };
  const next = { [machineKey("m1")]: { name: "Laptop", at: 200 }, [groupKey("m1", "dev")]: { ...g, at: 200 } };
  const r = planWrite("m1", stored, next, 200);
  assert.deepEqual(r.remove, [groupKey("m1", "old")]);
  assert.deepEqual(Object.keys(r.set), [machineKey("m1")]); // heartbeat rides along with the removal

  delete stored[groupKey("m1", "old")];
  assert.equal(planWrite("m1", stored, next, 200).set, null);
  assert.ok(planWrite("m1", stored, next, 100 + 2 * DAY).set); // daily heartbeat
  const renamed = { ...next, [machineKey("m1")]: { name: "Work", at: 200 } };
  assert.deepEqual(Object.keys(planWrite("m1", stored, renamed, 200).set), [machineKey("m1")]);
});

test("readMachines: lists machines newest first, marks long-gone machines and orphans stale", () => {
  const now = 100 * DAY;
  const all = {
    rules: [],
    [machineKey("me")]: { name: "Here", at: now },
    [machineKey("lap")]: { name: "Laptop", at: now - DAY },
    [groupKey("lap", "b")]: { title: "b", tabs: [] },
    [groupKey("lap", "a")]: { title: "a", tabs: [] },
    [machineKey("gone")]: { name: "Old", at: now - 40 * DAY },
    [groupKey("gone", "x")]: { title: "x", tabs: [] },
    [groupKey("orphan", "y")]: { title: "y", tabs: [] },
  };
  const { machines, stale } = readMachines(all, "me", now);
  assert.deepEqual(machines.map((m) => m.id), ["me", "lap"]);
  assert.deepEqual(machines[1].groups.map((g) => g.title), ["a", "b"]);
  assert.deepEqual(stale.sort(), [groupKey("gone", "x"), machineKey("gone"), groupKey("orphan", "y")].sort());
});

test("missingHere ignores #fragments and drops fully open groups", () => {
  const machine = {
    groups: [
      { title: "a", tabs: [{ u: "https://a.test/1" }, { u: "https://a.test/2" }] },
      { title: "b", tabs: [{ u: "https://b.test/1#x" }] },
    ],
  };
  const out = missingHere(machine, ["https://a.test/1#y", "https://b.test/1"]);
  assert.deepEqual(out.map((g) => [g.title, g.missing.map((t) => t.u)]), [["a", ["https://a.test/2"]]]);
  assert.equal(urlKey("not a url"), "not a url");
});
