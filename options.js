import { COLORS, checkPattern, isGroupable, matchRule, normTitle, resolveRules } from "./lib.js";
import { FLAGS, isSettingsKey, loadSettings, newId, saveLists } from "./settings.js";

const COLOR_HEX = {
  grey: "#5f6368", blue: "#1a73e8", red: "#d93025", yellow: "#f9ab00", green: "#188038",
  pink: "#d01884", purple: "#a142f4", cyan: "#007b83", orange: "#fa903e",
};

const $ = (id) => document.getElementById(id);

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "style") Object.assign(node.style, v);
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (k.startsWith("aria-") || k === "role") node.setAttribute(k, v);
    else node[k] = v;
  }
  for (const c of children.flat()) if (c != null) node.append(c);
  return node;
}

const state = { groups: [], rules: [] };
let saveTimer = null;
let lastSaved = "";

function flash(text) {
  $("status").textContent = text;
  clearTimeout(flash.t);
  flash.t = setTimeout(() => ($("status").textContent = ""), 1500);
}

// ---------------------------------------------------------------------------
// Saving. Structural changes save at once; typing saves after a pause.

async function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const snapshot = JSON.stringify(state);
  if (snapshot === lastSaved) return;
  lastSaved = snapshot;
  await saveLists(state.groups, state.rules);
  flash("Saved");
}

function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 500);
}

// ---------------------------------------------------------------------------
// Drag to reorder. A row only becomes draggable while its handle is held, so
// text in its inputs can still be selected. Arrow keys on the handle move it too.

function sortable(list, onReorder) {
  let dragged = null;
  list.addEventListener("pointerdown", (e) => {
    const handle = e.target.closest(".handle");
    if (handle) handle.closest(".item").draggable = true;
  });
  list.addEventListener("dragstart", (e) => {
    dragged = e.target.closest(".item");
    if (!dragged) return;
    dragged.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", dragged.dataset.id);
  });
  list.addEventListener("dragover", (e) => {
    if (!dragged) return;
    e.preventDefault();
    const over = e.target.closest(".item");
    if (!over || over === dragged || over.parentNode !== list) return;
    const r = over.getBoundingClientRect();
    list.insertBefore(dragged, e.clientY > r.top + r.height / 2 ? over.nextSibling : over);
  });
  list.addEventListener("drop", (e) => e.preventDefault());
  list.addEventListener("dragend", () => {
    if (!dragged) return;
    dragged.classList.remove("dragging");
    dragged.draggable = false;
    dragged = null;
    onReorder([...list.children].map((li) => li.dataset.id));
  });
  list.addEventListener("keydown", (e) => {
    const handle = e.target.closest(".handle");
    if (!handle || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    e.preventDefault();
    const item = handle.closest(".item");
    const sibling = e.key === "ArrowUp" ? item.previousElementSibling : item.nextElementSibling;
    if (!sibling) return;
    list.insertBefore(item, e.key === "ArrowUp" ? sibling : sibling.nextSibling);
    handle.focus();
    onReorder([...list.children].map((li) => li.dataset.id));
  });
}

function reorder(arr, ids) {
  const byId = new Map(arr.map((x) => [x.id, x]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

const handle = (label) => el("button", { class: "handle", textContent: "⋮⋮", title: `Drag to reorder ${label} (or use arrow keys)`, "aria-label": `Reorder ${label}` });

// ---------------------------------------------------------------------------
// Groups

function groupRow(g) {
  const palette = el(
    "div",
    { class: "palette", hidden: true, role: "menu" },
    COLORS.map((c) =>
      el("button", {
        title: c,
        "aria-label": c,
        "aria-pressed": String(c === g.color),
        style: { background: COLOR_HEX[c] },
        onclick: () => {
          g.color = c;
          saveNow();
          render();
        },
      }),
    ),
  );
  const swatch = el("button", {
    class: "swatch",
    title: `Color: ${g.color}`,
    "aria-label": `Color: ${g.color}`,
    style: { background: COLOR_HEX[g.color] ?? COLOR_HEX.grey },
    onclick: (e) => {
      e.stopPropagation();
      const open = palette.hidden;
      document.querySelectorAll(".palette").forEach((p) => (p.hidden = true));
      palette.hidden = !open;
    },
  });
  const name = el("input", {
    type: "text",
    class: "name",
    value: g.name,
    placeholder: "Group name",
    "aria-label": "Group name",
    maxLength: 60,
    oninput: () => {
      g.name = name.value;
      saveSoon();
      renderRuleTargets();
    },
    onchange: () => {
      g.name = name.value.trim();
      saveNow();
      refreshGroupMeta();
    },
  });
  return el(
    "li",
    { class: "item", dataset: { id: g.id } },
    handle("group"),
    el("div", { class: "swatch-wrap" }, swatch, palette),
    name,
    el("span", { class: "count" }),
    el("button", {
      class: "remove",
      textContent: "✕",
      title: "Delete group",
      "aria-label": `Delete group ${g.name}`,
      onclick: () => {
        const ruleCount = state.rules.filter((r) => r.group === g.id).length;
        if (ruleCount && !confirm(`Delete "${g.name || "this group"}" and its ${ruleCount === 1 ? "rule" : `${ruleCount} rules`}?`)) return;
        state.groups = state.groups.filter((x) => x !== g);
        state.rules = state.rules.filter((r) => r.group !== g.id);
        saveNow();
        render();
      },
    }),
  );
}

// ---------------------------------------------------------------------------
// Rules

function targetSelect(r) {
  const dot = el("span", { class: "dot" });
  const select = el(
    "select",
    {
      "aria-label": "Group",
      onchange: () => {
        r.group = select.value;
        paint();
        saveNow();
        refreshGroupMeta();
        runTest();
      },
    },
    state.groups.map((g) => el("option", { value: g.id, textContent: g.name || "(unnamed group)", selected: g.id === r.group })),
  );
  const paint = () => {
    const g = state.groups.find((x) => x.id === select.value);
    dot.style.background = COLOR_HEX[g?.color] ?? COLOR_HEX.grey;
  };
  paint();
  return el("div", { class: "target" }, dot, select);
}

function ruleRow(r) {
  const error = el("div", { class: "error" });
  const pattern = el("input", {
    type: "text",
    class: "pattern",
    value: r.pattern,
    placeholder: "github.com",
    spellcheck: false,
    "aria-label": "Pattern",
    oninput: () => {
      r.pattern = pattern.value.trim();
      showError();
      saveSoon();
      runTest();
    },
    onchange: () => saveNow(),
  });
  const showError = () => {
    const msg = r.pattern ? checkPattern(r.pattern) : "";
    error.textContent = msg;
    pattern.classList.toggle("invalid", !!msg);
  };
  showError();
  const item = el(
    "li",
    { class: `item${r.enabled === false ? " off" : ""}`, dataset: { id: r.id } },
    handle("rule"),
    el(
      "label",
      { class: "switch", title: "Rule on or off" },
      el("input", {
        type: "checkbox",
        checked: r.enabled !== false,
        "aria-label": "Rule enabled",
        onchange: (e) => {
          r.enabled = e.target.checked;
          item.classList.toggle("off", !r.enabled);
          saveNow();
          runTest();
        },
      }),
      el("span"),
    ),
    el("div", { class: "field" }, pattern, error),
    el(
      "label",
      { class: "sub", title: "Also match every page below this one" },
      el("input", {
        type: "checkbox",
        checked: !!r.subpages,
        onchange: (e) => {
          r.subpages = e.target.checked;
          saveNow();
          runTest();
        },
      }),
      "subpages",
    ),
    el("span", { class: "arrow", textContent: "→" }),
    targetSelect(r),
    el("button", {
      class: "remove",
      textContent: "✕",
      title: "Delete rule",
      "aria-label": `Delete rule ${r.pattern}`,
      onclick: () => {
        state.rules = state.rules.filter((x) => x !== r);
        saveNow();
        render();
      },
    }),
  );
  return item;
}

// Rule counts and duplicate-name warnings, updated in place so typing and
// tabbing between fields isn't interrupted.
function refreshGroupMeta() {
  for (const li of $("groups").children) {
    const g = state.groups.find((x) => x.id === li.dataset.id);
    if (!g) continue;
    const n = state.rules.filter((r) => r.group === g.id).length;
    li.dataset.rules = n;
    li.querySelector(".count").textContent = n === 1 ? "1 rule" : `${n} rules`;
    const dupe = state.groups.some((o) => o !== g && normTitle(o.name) && normTitle(o.name) === normTitle(g.name));
    const input = li.querySelector(".name");
    input.classList.toggle("invalid", dupe);
    input.title = dupe ? "Another group has this name. Tabs for both go to one group." : "";
  }
}

// Group names changed: refresh the rule dropdowns without rebuilding inputs.
function renderRuleTargets() {
  for (const li of $("rules").children) {
    const r = state.rules.find((x) => x.id === li.dataset.id);
    if (r) li.querySelector(".target").replaceWith(targetSelect(r));
  }
  runTest();
}

// ---------------------------------------------------------------------------

function render() {
  $("groups").replaceChildren(...state.groups.map(groupRow));
  $("groupsEmpty").hidden = state.groups.length > 0;
  refreshGroupMeta();
  $("rules").replaceChildren(...state.rules.map(ruleRow));
  $("addRule").disabled = !state.groups.length;
  $("rulesEmpty").hidden = state.rules.length > 0;
  $("rulesEmpty").textContent = state.groups.length ? "No rules yet." : "Add a group first, then rules that send tabs to it.";
  runTest();
}

function runTest() {
  const out = $("testResult");
  const raw = $("testUrl").value.trim();
  if (!raw) return out.replaceChildren();
  const url = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  if (!isGroupable(url)) return out.replaceChildren("Only http, https and file pages are grouped.");
  const live = resolveRules(state.groups, state.rules);
  const hit = matchRule(live, url);
  if (!hit) return out.replaceChildren("No rule matches, so the tab stays where it is.");
  const n = state.rules.findIndex((r) => r.id === hit.id) + 1;
  out.replaceChildren(
    "Goes to ",
    el("span", { class: "dot", style: { background: COLOR_HEX[hit.color] ?? COLOR_HEX.grey } }),
    el("strong", { textContent: hit.group }),
    ` (rule ${n}: ${hit.pattern}${hit.subpages ? " and subpages" : ""})`,
  );
}

async function load() {
  const s = await loadSettings();
  state.groups = s.groups;
  state.rules = s.rules;
  lastSaved = JSON.stringify(state);
  $("enabled").checked = s.enabled;
  $("groupsToTop").checked = s.groupsToTop;
  document.querySelector(`input[name=scope][value=${s.scope}]`).checked = true;

  const local = await chrome.storage.local.get(["machineId", "machineName", "shareTabs", "setupDone"]);
  $("shareTabs").checked = local.shareTabs ?? true;
  const meta = local.machineId ? (await chrome.storage.sync.get(`m:${local.machineId}`))[`m:${local.machineId}`] : null;
  $("machineName").value = local.machineName ?? "";
  chrome.runtime.sendMessage({ type: "machine" }).then((m) => {
    if (m) $("machineName").placeholder = local.machineName ? "" : meta?.name ?? m.machineName;
  });
  $("setup").hidden = !!local.setupDone && location.hash !== "#setup";
  render();
}

// ---------------------------------------------------------------------------

sortable($("groups"), (ids) => {
  state.groups = reorder(state.groups, ids);
  saveNow();
  render();
});
sortable($("rules"), (ids) => {
  state.rules = reorder(state.rules, ids);
  saveNow();
  runTest();
});

$("addGroup").addEventListener("click", () => {
  const used = new Set(state.groups.map((g) => g.color));
  const color = COLORS.find((c) => c !== "grey" && !used.has(c)) ?? "grey";
  state.groups.push({ id: newId(), name: "", color });
  render();
  $("groups").lastElementChild.querySelector(".name").focus();
});

$("addRule").addEventListener("click", () => {
  const last = state.rules.at(-1)?.group;
  const group = state.groups.some((g) => g.id === last) ? last : state.groups[0].id;
  state.rules.push({ id: newId(), pattern: "", group, subpages: true, enabled: true });
  render();
  $("rules").lastElementChild.querySelector(".pattern").focus();
});

$("testUrl").addEventListener("input", runTest);
document.addEventListener("click", (e) => {
  if (!e.target.closest(".swatch-wrap")) document.querySelectorAll(".palette").forEach((p) => (p.hidden = true));
});

for (const id of ["enabled", "groupsToTop"]) {
  $(id).addEventListener("change", async () => {
    await chrome.storage.sync.set({ [id]: $(id).checked });
    flash("Saved");
  });
}
document.querySelectorAll("input[name=scope]").forEach((r) =>
  r.addEventListener("change", async () => {
    await chrome.storage.sync.set({ scope: r.value });
    flash("Saved");
  }),
);

$("shareTabs").addEventListener("change", async () => {
  await chrome.storage.local.set({ shareTabs: $("shareTabs").checked });
  flash("Saved");
});
$("machineName").addEventListener("change", async () => {
  const name = $("machineName").value.trim();
  if (name) await chrome.storage.local.set({ machineName: name });
  else await chrome.storage.local.remove("machineName");
  flash("Saved");
});

$("sweep").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "sweep" });
  flash("Sorting");
});
$("clear").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "clearOverrides" });
  flash("Manual moves forgotten");
});

$("openSync").addEventListener("click", () => chrome.tabs.create({ url: "chrome://settings/syncSetup/advanced" }));
$("setupDone").addEventListener("click", async () => {
  await chrome.storage.local.set({ setupDone: true });
  $("setup").hidden = true;
  if (location.hash) history.replaceState(null, "", location.pathname);
});
$("showSetup").addEventListener("click", () => {
  $("setup").hidden = false;
  $("setup").scrollIntoView({ behavior: "smooth" });
});

// Another machine (or another settings tab) changed the lists. Take its
// version unless this page has an edit waiting to be saved.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "sync" || !Object.keys(changes).some(isSettingsKey)) return;
  const flags = Object.keys(FLAGS).filter((k) => k in changes);
  if (flags.length) {
    const s = await loadSettings();
    $("enabled").checked = s.enabled;
    $("groupsToTop").checked = s.groupsToTop;
    document.querySelector(`input[name=scope][value=${s.scope}]`).checked = true;
  }
  if (saveTimer) return;
  const s = await loadSettings();
  const theirs = JSON.stringify({ groups: s.groups, rules: s.rules });
  if (theirs === JSON.stringify(state)) return;
  if (document.activeElement?.closest?.(".list")) return; // don't yank a field out from under the cursor
  state.groups = s.groups;
  state.rules = s.rules;
  lastSaved = theirs;
  render();
});

load();
