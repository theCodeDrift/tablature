# Tablature

Tablature is a Chrome extension that puts tabs into groups by URL rule and treats a group's name as its identity: there is one "social" group, never seven.

## What it does

- **Rules.** `group | color | pattern`, first match wins, `*` wildcards. Rules live in `chrome.storage.sync`, so every machine signed into Chrome gets the same group names.
- **Already-open tabs.** On install, on browser start, on any new window and on every rule change, it sorts every tab, not only new ones.
- **One group per name.** Same-name groups (case and whitespace ignored) are merged automatically, within each window by default or across all windows if you pick that. An emptied group disappears on its own; Chrome has no delete call for groups.
- **Groups at the front.** Ruled groups sit right after pinned tabs, in the order they first appear in the rules.
- **More events.** New tabs, URL changes (including single-page-app navigation), tabs dragged between windows, prerender tab swaps, new windows, and groups that get their title late after a session restore.
- **Manual moves stick.** Drag a tab out of a group by hand and the extension leaves that tab alone until it closes. "Forget manual moves" on the options page resets that.
- **Groups across machines.** Each machine shares a snapshot of its named groups (up to 50 tabs each) through Chrome sync. The toolbar button lists, per machine, the tabs in each group that aren't open here, with **Open** to bring them into the same-name group in this window. Nothing opens or closes on its own, and closing a tab on one machine never closes it on another. Machines unseen for 30 days are dropped. Turn sharing off or rename the machine on the options page.

### How sharing is stored

Each machine writes only its own keys, so machines never overwrite each other:

- `m:<machineId>`: `{ name, at }`
- `g:<machineId>:<group name>`: `{ title, color, tabs: [{ u, t }], more, at }`

Chrome sync allows about 100 KB in total and 8 KB per item, so each group is trimmed to fit (`more` counts what was left out), and the per-group cap drops when many machines and groups share the space. Snapshots are written a few seconds after a change and at most every 15 seconds.

## Set Chrome up so it stops making copies

Chrome saves and pins every new group by itself, and an extension can't see or delete those saved copies. To stop them from piling up:

1. Turn off auto-pinning new tab groups to the bookmarks bar, if your Chrome has that setting.
2. Turn off tab-group sync in Chrome's sync settings, so only this extension recreates groups.
3. Delete the existing duplicate saved groups by hand, once.

## Install (unpacked)

1. Download `tablature-<version>.zip` from the [releases](https://github.com/theCodeDrift/tablature/releases) and unzip it, or use a checkout of this repo.
2. Open `chrome://extensions` and turn on Developer mode.
3. Click **Load unpacked** and pick the unzipped folder.
4. Pin Tablature to the toolbar. Its popup shows other machines' groups; **Settings** there opens the rules.

The manifest carries a `key`, so the extension ID is `efjdfbahfkmmadlabjpogbmecbidgbmo` wherever it is loaded from. Chrome sync storage is per extension ID, so this is what lets two machines share rules and groups. To test sharing, install it on two computers signed into the same Chrome profile with sync on.

To update, unzip the new version over the old folder and click the reload icon on `chrome://extensions`. Settings and rules are kept.

## Release

```
npm run package   # dist/tablature-<version>.zip, needs python3
```

## Test

```
node --test
```

Covers the pure logic in `lib.js` (matching, rule parsing, merge and order planning).

```
npm install
npx playwright install chromium   # once
npm run test:browser
```

Loads the extension unpacked in Playwright's Chromium and checks the `chrome.*` side: sorting already-open tabs on rule change, new tabs, navigation (including single-page-app `pushState`), same-name merges, group order after pinned tabs, manual moves sticking and "Forget manual moves", the options page, window vs. global scope, the enabled switch, and a service worker restart. Every http(s) request is answered locally, so it needs no network. Set `CHROME=/path/to/chrome` to use another Chromium build.

## Not yet

- Importing rules from Tab Auto Group.
