# Changelog

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
