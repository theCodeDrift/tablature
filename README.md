# One Group Per Name

A Chrome extension that puts tabs into groups by URL rule and treats a group's name as its identity: there is one "social" group, never seven.

## What it does

- **Rules.** `group | color | pattern`, first match wins, `*` wildcards. Rules live in `chrome.storage.sync`, so every machine signed into Chrome gets the same group names.
- **Already-open tabs.** On install, on browser start, on any new window and on every rule change, it sorts every tab, not only new ones.
- **One group per name.** Same-name groups (case and whitespace ignored) are merged automatically, within each window by default or across all windows if you pick that. An emptied group disappears on its own; Chrome has no delete call for groups.
- **Groups at the front.** Ruled groups sit right after pinned tabs, in the order they first appear in the rules.
- **More events.** New tabs, URL changes (including single-page-app navigation), tabs dragged between windows, prerender tab swaps, new windows, and groups that get their title late after a session restore.
- **Manual moves stick.** Drag a tab out of a group by hand and the extension leaves that tab alone until it closes. "Forget manual moves" on the options page resets that.

## Set Chrome up so it stops making copies

Chrome saves and pins every new group by itself, and an extension can't see or delete those saved copies. To stop them from piling up:

1. Turn off auto-pinning new tab groups to the bookmarks bar, if your Chrome has that setting.
2. Turn off tab-group sync in Chrome's sync settings, so only this extension recreates groups.
3. Delete the existing duplicate saved groups by hand, once.

## Install (unpacked)

1. `chrome://extensions`, turn on Developer mode.
2. Load unpacked, pick this folder.
3. Click the toolbar icon to edit rules.

## Test

```
node --test
```

Covers the pure logic in `lib.js` (matching, rule parsing, merge and order planning). The `chrome.*` side needs a real browser.

## Not yet

- Syncing the tabs inside a group between machines. Today, names sync and each machine builds its own "social". Next step: keep each group's URL list in synced storage and offer "restore the rest of this group" on demand.
- Importing rules from Tab Auto Group.
