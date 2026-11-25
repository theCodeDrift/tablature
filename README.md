# Tablature

Tablature is a Chrome extension that puts tabs into groups by URL rule and treats a group's name as its identity: there is one "social" group, never seven.

## What it does

- **Groups and rules.** The settings page has two lists. *Tab groups* holds each group's name and color, in the order they sit at the front of the tab strip. *Rules* send matching tabs to a group; the first rule that matches wins. Add, delete, switch off, and drag either list to reorder (arrow keys on the handle work too). Changes save as you go, and a "Test an address" box shows which rule a URL would hit. Renaming or recoloring a group changes the open group to match. Everything lives in `chrome.storage.sync`, so every machine signed into Chrome gets the same groups and rules.
- **Patterns.** Written the way you'd say them. No protocol means any protocol. A bare domain like `github.com` matches both `github.com` and `www.github.com`; `www.github.com` matches only www; `*.bsky.app` matches bsky.app and every subdomain. The *subpages* switch also matches everything below the path (`github.com/jakobo` → `github.com/jakobo/tablature`, never `github.com/jakobonew`). `*` matches anything. The query string and `#fragment` are ignored. Rules from 0.1 and 0.2 are migrated automatically.
- **Setup.** Installing opens the settings page at a short setup guide: turn off Chrome's own tab group sync (with a button to its settings page), clear old saved copies, add groups. Chrome doesn't let extensions read its sync settings, so Tablature can't check this for you.
- **Already-open tabs.** On install, on browser start, on any new window and on every rule change, it sorts every tab, not only new ones.
- **Tabs leave groups too.** A tab in one of your groups that moves to a page no rule sends there (another GitHub repo, say) is taken out of the group, and a group that empties disappears. If a rule sends it to a different group, it moves there instead. Groups you made yourself, tabs you dragged in by hand, and new-tab or `chrome://` pages are left alone.
- **One group per name.** Same-name groups (case and whitespace ignored) are merged automatically, within each window by default or across all windows if you pick that. An emptied group disappears on its own; Chrome has no delete call for groups.
- **Groups at the front.** Ruled groups sit right after pinned tabs, in the order they first appear in the rules.
- **More events.** New tabs, URL changes (including single-page-app navigation), tabs dragged between windows, prerender tab swaps, new windows, and groups that get their title late after a session restore.
- **Manual moves stick.** Drag a tab out of a group by hand and the extension leaves that tab alone until it closes. "Forget manual moves" on the options page resets that.
- **Groups across machines.** Each machine shares a snapshot of its named groups (up to 50 tabs each) through Chrome sync. The toolbar button lists, per machine, the tabs in each group that aren't open here, with **Open** to bring them into the same-name group in this window. Nothing opens or closes on its own, and closing a tab on one machine never closes it on another. Machines unseen for 30 days are dropped. Turn sharing off or rename the machine on the options page.

### How sharing is stored

Settings are shared by every machine. For groups' tabs, each machine writes only its own keys, so machines never overwrite each other:

- `groupList`: `[{ id, name, color }]`; `rules.n` and `rules.0`, `rules.1` ...: `[{ id, pattern, group, subpages, enabled }]` in chunks under the 8 KB item limit
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
4. The settings page opens with setup steps. Pin Tablature to the toolbar: its popup shows other machines' groups, and **Settings** there opens the groups and rules.

The manifest carries a `key`, so the extension ID is `efjdfbahfkmmadlabjpogbmecbidgbmo` wherever it is loaded from. Chrome sync storage is per extension ID, so this is what lets two machines share rules and groups. To test sharing, install it on two computers signed into the same Chrome profile with sync on.

To update, unzip the new version over the old folder and click the reload icon on `chrome://extensions`. Settings and rules are kept.

## Release

```
npm run package         # dist/tablature-<version>.zip for unpacked installs, needs python3
npm run package:store   # dist/tablature-<version>-store.zip for the Chrome Web Store
npm run store:assets    # store/ screenshots and promo tile, from the real extension
```

Bump `version` in both `manifest.json` and `package.json` first; the store refuses a version it has already seen.

### Chrome Web Store

The listing text, permission justifications and privacy answers are in [`store/LISTING.md`](store/LISTING.md), the privacy policy in [`store/PRIVACY.md`](store/PRIVACY.md), and the images in `store/`.

The store build leaves out the manifest's `key`, because the store refuses it and assigns its own ID. A store install therefore has a different extension ID from an unpacked one, and they don't share settings or groups through sync. Use the same kind of install on every machine.

First submission:

1. Register at the [developer dashboard](https://chrome.google.com/webstore/devconsole) (one-time US$5 fee, 2-step verification required).
2. Privacy policy URL: https://github.com/theCodeDrift/tablature/blob/main/store/PRIVACY.md
3. **Add new item** and upload `dist/tablature-<version>-store.zip`.
4. Fill in the Store listing, Privacy practices, Distribution and Test instructions tabs from `store/LISTING.md`.
5. Submit for review. Review usually takes a few days.

Updates: bump the version, `npm run package:store`, upload on the item's **Package** tab, submit.

## Test

```
node --test
```

Covers the pure logic in `lib.js` and `sync.js` (pattern matching, placement, migration, storage chunking, merge and order planning, snapshots).

```
npm install
npx playwright install chromium   # once
npm run test:browser
```

Loads the extension unpacked in Playwright's Chromium and drives it: sorting already-open tabs, new tabs, navigation (including single-page-app `pushState`), same-name merges, group order, manual moves, the settings page (adding, dragging, renaming, deleting groups and rules, setup steps), sharing between machines and the popup, window vs. global scope, and a service worker restart. Every http(s) request is answered locally, so it needs no network. Set `CHROME=/path/to/chrome` to use another Chromium build.

## Not yet

- Importing rules from Tab Auto Group.

## License

Copyright 2026 Jakob Heuser. Licensed under the [Apache License, Version 2.0](LICENSE).
