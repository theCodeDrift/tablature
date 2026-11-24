import { formatRules, parseRules } from "./lib.js";

const $ = (id) => document.getElementById(id);
const DEFAULTS = { rules: [], enabled: true, groupsToTop: true, scope: "window" };

function flash(text) {
  $("status").textContent = text;
  setTimeout(() => ($("status").textContent = ""), 2000);
}

async function load() {
  const s = await chrome.storage.sync.get(DEFAULTS);
  $("rules").value = formatRules(s.rules);
  $("enabled").checked = s.enabled;
  $("groupsToTop").checked = s.groupsToTop;
  document.querySelector(`input[name=scope][value=${s.scope}]`).checked = true;

  const local = await chrome.storage.local.get(["machineId", "machineName", "shareTabs"]);
  $("shareTabs").checked = local.shareTabs ?? true;
  const meta = local.machineId ? (await chrome.storage.sync.get(`m:${local.machineId}`))[`m:${local.machineId}`] : null;
  $("machineName").value = local.machineName ?? meta?.name ?? "";
}

$("save").addEventListener("click", async () => {
  const { rules, errors } = parseRules($("rules").value);
  $("errors").textContent = errors.join("\n");
  if (errors.length) return;
  await chrome.storage.sync.set({
    rules,
    enabled: $("enabled").checked,
    groupsToTop: $("groupsToTop").checked,
    scope: document.querySelector("input[name=scope]:checked").value,
  });
  const machineName = $("machineName").value.trim();
  await chrome.storage.local.set({ shareTabs: $("shareTabs").checked });
  if (machineName) await chrome.storage.local.set({ machineName });
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

load();
