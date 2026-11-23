# Changelog

## [0.5.0]

### Changed
- **Charges come from Your Payments › Transactions.** Amazon's order pages and invoices no longer
  list an order's card charges (they're behind "View related transactions"). The sync now reads
  Amazon's Transactions page, finds each charge Ledger hasn't split by amount, date and card, and
  opens only the orders those charges name. Your Orders is only walked if that page shows nothing.
- **Copy Page Outline** includes the Transactions page.

### Fixed
- Every item in a shipment is read on Amazon's current order page; before, only the first item of
  each shipment was.
- Shipments on the current order page are told apart.

## [0.4.3]

### Fixed
- **Closing the sync tab stops the sync.** Before, closing it between pages just opened a new one.
- **Stop Sync** button while a sync runs.
- With **Sync automatically** off, nothing syncs on its own, including the sync after an update.
- When Your Orders shows no dates and three orders in a row can't be opened, the sync stops
  instead of walking further back.

## [0.4.2]

### Fixed
- **No more walking back through old orders.** When Your Orders doesn't show an order's date,
  the sync opens that order to learn it and stops at the first one older than it needs, instead
  of treating every undated order as possibly needed.

## [0.4.1]

### Fixed
- **Locked order lists are read in the tab.** When Your Orders arrives with its order boxes
  locked, the sync now switches to the background tab for the list too, instead of taking a stray
  order number from elsewhere on the page (which Amazon then refused as "unable to load your order
  details").
- While a sync runs, the popup no longer shows the last sync's problem.

## [0.4.0]

Works best with Ledger 0.110.0, which says which Amazon charges aren't split yet.

### Changed
- **Only the orders it needs.** Ledger lists the Amazon charges it hasn't split; the sync reads
  only orders placed in the 30 days before one of them, oldest first, and stops as soon as every
  charge has turned up in an order's charge list. With nothing left to split it doesn't open
  Amazon at all. (With an older Ledger it reads everything since Ledger's start day, as before.)
- **The tab only when Amazon insists.** Order pages are read with plain requests first; the
  background tab opens only if Amazon answers with locked order boxes, "unable to load your order
  details", or a robot check, and then for the rest of that sync.
- **Clearer counts:** "Unsplit 25 · Found 18 · Still missing 7", then orders read, orders with no
  charge list, skipped, split, categories, and whether a tab was needed.
- **Copy Page Outline** shows Your Orders, the first order whose page has no charge list, and
  that order's invoice, which is what's needed to fix missing charges. It now also appears when
  charges are still missing.

## [0.3.1]

### Fixed
- A problem screen (like "Amazon changed its pages") now also offers **Sync Now**, so you can
  retry without waiting for the next automatic sync.
- Updating the extension clears the last problem and runs a sync a minute later.

## [0.3.0]

### Changed
- **Orders are read in a background tab.** Amazon now unlocks order details only inside a real
  page (its own scripts decrypt them), so the sync opens one tab behind your current one, reads
  Your Orders and each order there, and closes it when done. Product pages are still read without
  a tab. Adds Chrome's `scripting` permission, limited to amazon.com.
- **Copy Page Outline** reads the pages the same way, so it shows what the sync sees.

### Fixed
- An order list whose boxes never unlocked is reported as unreadable, not as a year with no
  orders.
- Amazon's "unable to load your order details" page is told apart from a changed page
  ("Amazon wouldn't show order details").
- Closing the sync tab stops the sync quietly ("Sync stopped"); it tries again next time.

## [0.2.1]

### Fixed
- One order with an odd date on Your Orders no longer ends the sync early; it stops only when a
  whole page is before the start day.
- A sync that couldn't read any order page now shows "Amazon changed its pages" instead of
  looking fine.
- **Copy Page Outline** now shows whenever the last sync read little or nothing, and outlines
  both Your Orders and one order page (Amazon's header, menus and footer left out).
- "Synced through" uses your own date, not UTC.

## [0.2.0]

Needs Ledger 0.108.0 for per-item splits by category.

### Added
- **Amazon's category for each item.** Each new product's page is read once (with the usual
  pause) for its category trail, which Ledger uses to place the item. Categories are cached for
  180 days, at most 2,000 products.
- Each item's product id is sent too, so a category you fix in Ledger sticks to that product.
- **Last sync counts** in the popup: orders found, sent, done before, skipped (digital,
  cancelled, unreadable), split, waiting, no match, no charge list, and how many items got a
  category.

### Fixed
- **Orders charged after they were placed were missed.** The sync stopped at orders placed before
  its start day, but Amazon charges when an order ships. It now reads orders placed up to 30 days
  earlier.
- If Your Orders has no Next link on a full page, the next page is still read.
- Orders whose charges are all split aren't read again (kept as salted hashes, not order
  numbers). After Amazon splits are removed in Ledger, every order is read again.
- The popup no longer shows "Syncing" for a sync that stopped.

## [0.1.0]

First release.

- Connects to Ledger with an Amazon-only device token (Ledger 0.106.0 or later).
- Syncs every 6 hours and when Chrome starts, plus **Sync Now**. Starts where Ledger's last
  Amazon split left off.
- Reads Your Orders, each order's page and, when needed, its invoice; sends item names,
  prices, quantities, shipments and card charges to Ledger in batches.
- Stops and reports on an Amazon sign-in page, a captcha, or pages it can't read, naming the
  part that broke. **Copy Page Outline** copies a masked outline of that page.
- Popup: setup, last sync, charges split this month, orders waiting on the bank, automatic sync
  switch, accent color.
