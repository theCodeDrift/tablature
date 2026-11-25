# Tablature privacy policy

_Last updated: November 25, 2026_

Tablature is a Chrome extension that sorts your tabs into named tab groups by rules you write. This page explains what it reads, where that goes, and what it never does.

## What Tablature reads

- **The address (URL) of your tabs**, to check it against your rules and decide which group a tab belongs in.
- **The title and address of tabs inside your named groups**, if "Share this machine's groups" is on (it is by default), so your other computers can list them.
- **Your tab groups' names and colors**, to merge groups with the same name and keep them in order.

## Where it is stored

Everything stays in your own browser and your own Google account. Tablature has no server and sends nothing to its developer or to anyone else.

- **Your settings** (groups, rules and options) are saved with `chrome.storage.sync`. Chrome keeps them in your Google account so every computer signed into your Chrome profile gets the same settings.
- **Group snapshots**: if sharing is on, each computer saves a list of the tabs in its named groups (title and address, at most 50 per group) and the computer's name to `chrome.storage.sync`, so your other computers can show them in the toolbar popup. Turning sharing off deletes that computer's snapshots. Computers not seen for 30 days are removed.
- **On this computer only**: a random ID and name for this computer (`chrome.storage.local`), and which tabs you moved by hand (`chrome.storage.session`, cleared when Chrome closes).

Chrome sync is run by Google under [Google's privacy policy](https://policies.google.com/privacy). If Chrome sync is off, Tablature's data stays on the one computer.

## What Tablature never does

- It does not collect, sell or transfer your data to the developer or any third party.
- It does not use analytics, ads or trackers.
- It does not read the content of web pages, only tab addresses and titles.
- It does not load code from the internet.

## Removing your data

Uninstalling Tablature removes its data from your browser. To also remove the copies in Chrome sync, first turn off "Share this machine's groups" on each computer and delete your groups and rules on the settings page, or clear Chrome sync data at https://chrome.google.com/sync.

## Contact

Questions about this policy: open an issue at https://github.com/theCodeDrift/tablature/issues or email the contact address on the Chrome Web Store listing.
