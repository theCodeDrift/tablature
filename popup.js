import { missingHere, readMachines } from "./sync.js";

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
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node[k] = v;
  }
  for (const c of children.flat()) if (c != null) node.append(c);
  return node;
}

function ago(ms) {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

function host(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

async function restore(group, urls, button) {
  button.disabled = true;
  const res = await chrome.runtime.sendMessage({ type: "restore", urls, title: group.title, color: group.color });
  if (!res?.ok) {
    button.disabled = false;
    button.textContent = "Failed";
    button.title = res?.error ?? "";
    return;
  }
  render();
}

function groupRow(g) {
  const urls = g.missing.map((t) => t.u);
  const button = el("button", {
    class: "open",
    textContent: `Open ${urls.length}`,
    title: `Open these ${urls.length} tabs in this window's "${g.title}" group`,
    onclick: (e) => {
      e.preventDefault();
      restore(g, urls, button);
    },
  });
  const extra = g.more ? ` (+${g.more} not shared)` : "";
  return el(
    "details",
    { class: "group" },
    el(
      "summary",
      {},
      el("span", { class: "dot", style: { background: COLOR_HEX[g.color] ?? COLOR_HEX.grey } }),
      el("span", { class: "name", textContent: g.title }),
      el("span", { class: "count", textContent: `${g.missing.length} of ${g.tabs.length} not open here${extra}` }),
      button,
    ),
    el(
      "ul",
      { class: "tabs" },
      g.missing.map((t) =>
        el(
          "li",
          {},
          el("a", {
            href: t.u,
            textContent: t.t || t.u,
            title: t.u,
            onclick: (e) => {
              e.preventDefault();
              restore(g, [t.u], button);
            },
          }),
          el("span", { class: "host", textContent: host(t.u) }),
        ),
      ),
    ),
  );
}

async function render() {
  const [{ machineId, machineName, shareTabs = true }, all, tabs] = await Promise.all([
    chrome.storage.local.get(["machineId", "machineName", "shareTabs"]),
    chrome.storage.sync.get(null),
    chrome.tabs.query({}),
  ]);
  const { machines } = readMachines(all, machineId, Date.now());
  const me = machines.find((m) => m.id === machineId);
  $("me").textContent = shareTabs ? `This machine: ${me?.name ?? machineName ?? "not shared yet"}` : "This machine isn't shared";

  const others = machines.filter((m) => m.id !== machineId);
  const box = $("machines");
  box.replaceChildren();
  if (!others.length) {
    box.append(
      el(
        "div",
        { class: "empty" },
        el("p", { textContent: "No other machines yet." }),
        el("p", {
          textContent:
            "Install Tablature on another computer signed into the same Chrome profile with sync on. Its named groups show up here, and you can open the tabs you don't have.",
        }),
      ),
    );
    return;
  }
  const localUrls = tabs.map((t) => t.url || t.pendingUrl).filter(Boolean);
  for (const m of others) {
    const groups = missingHere(m, localUrls);
    box.append(
      el(
        "section",
        { class: "machine" },
        el(
          "div",
          { class: "machine-head" },
          el("h2", { textContent: m.name }),
          el("span", { class: "muted", textContent: `updated ${ago(m.at)}` }),
        ),
        groups.length
          ? groups.map(groupRow)
          : el("div", {
              class: "uptodate",
              textContent: m.groups.length ? "Everything in its groups is open here." : "No named groups.",
            }),
      ),
    );
  }
}

$("sweep").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "sweep" });
  window.close();
});
$("settings").addEventListener("click", () => chrome.runtime.openOptionsPage());

render();
