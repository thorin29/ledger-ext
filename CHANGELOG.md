# Changelog

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
