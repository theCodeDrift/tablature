# Chrome Web Store listing

Everything the developer dashboard asks for, ready to paste. Images are in this
folder and are rebuilt with `npm run store:assets`. The package is built with
`npm run package:store` (writes `dist/tablature-<version>-store.zip`).

## Store listing tab

**Name** (from the manifest): Tablature

**Summary** (from the manifest, 127 of 132 characters):
Sorts tabs into named groups by URL rule, keeps one group per name, and lets you open a group's tabs from your other computers.

**Category:** Workflow & Planning

**Language:** English

**Description:**

```
Tablature puts your tabs into tab groups by site, and treats a group's name as its identity: there is one "Social" group, never seven.

WHAT IT DOES
• Rules you can read. Type a site like github.com and pick a group. Bare domains match www too, *.example.com matches every subdomain, and a "subpages" switch covers everything under a path. The first matching rule wins, and a "Test an address" box shows which rule a page would hit.
• One group per name. Groups with the same name are merged automatically, within each window or across all windows.
• Tabs follow your rules both ways. A tab that navigates to a matching site joins its group. A tab that leaves its group's sites leaves the group, and an empty group disappears.
• Groups at the front. Your groups line up right after pinned tabs, in the order you set.
• Already-open tabs too. Installing, starting Chrome, opening a window or changing a rule sorts every tab, not only new ones.
• Your choices stick. Drag a tab out of a group by hand and Tablature leaves it alone until it closes.
• Your groups on every computer. Settings sync through your Chrome profile. The toolbar button lists, for each of your other computers, the tabs in each group that aren't open here, with one click to open them into the same group. Nothing opens or closes on its own.

PRIVATE BY DESIGN
Tablature has no server, no analytics and no ads. Your settings and group snapshots are stored with Chrome sync in your own Google account. It reads tab addresses and titles, never page content.

TIP
Chrome saves and syncs tab groups by itself, which can bring back copies of groups Tablature merged. The setup guide that opens on install shows how to turn that off.
```

**Graphic assets:**
- Store icon: `icons/icon128.png` (128x128, 96px artwork with transparent padding)
- Screenshots (1280x800): `screenshot-1-strip.png`, `screenshot-2-rules.png`, `screenshot-3-machines.png`
- Small promo tile (440x280): `promo-small-440x280.png`
- Marquee promo tile: optional, not provided

**Official URL:** none (needs a verified site in Search Console)
**Homepage URL:** the GitHub repo, if public
**Support URL:** `https://github.com/theCodeDrift/tablature/issues`, if public

## Privacy practices tab

**Single purpose:**
Tablature organizes the browser's tabs into named tab groups according to URL rules the user writes, and shows the user the tabs in their groups on their other computers.

**Permission justifications:**

- `tabs`: Tablature reads each tab's URL to match it against the user's grouping rules, and reads the titles and URLs of tabs in named groups to show them on the user's other computers. Without it the extension cannot tell which group a tab belongs in.
- `tabGroups`: Tablature creates, names, colors, merges and reorders tab groups, which is the extension's purpose.
- `storage`: Saves the user's groups, rules and options (storage.sync, so they follow the user's Chrome profile), each computer's snapshot of its named groups so other computers can list them (storage.sync), this computer's name and ID (storage.local), and which tabs the user moved by hand (storage.session).

**Remote code:** No, I am not using remote code. All JavaScript is in the package.

**Data usage** (check these boxes):
- Web history: Yes. Tab URLs and titles are read to apply the user's rules, and URLs and titles of tabs in named groups are saved to chrome.storage.sync so the user's other computers signed into the same Chrome profile can list them.
- Everything else (personally identifiable information, health, financial, authentication, personal communications, location, user activity, website content): No.

**Certify all three:**
- I do not sell or transfer user data to third parties, outside of the approved use cases
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL:** wherever `store/PRIVACY.md` is published (see the submission steps in the README).

## Distribution tab

- Visibility: Public (or Unlisted for a soft launch: only people with the link can install it)
- Regions: All regions
- Pricing: Free

## Test instructions tab (for the reviewer)

```
No account or login needed. After installing, the settings page opens with a short setup guide.
1. Click "+ Add group", name it "Code". Click "+ Add rule", type github.com and choose Code.
2. Open https://github.com in a new tab: it joins a "Code" tab group.
3. In that tab, go to https://example.com: it leaves the group, and the empty group disappears.
The toolbar popup lists tab groups from other computers signed into the same Chrome profile; on a single computer it says "No other machines yet."
```
