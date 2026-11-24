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
