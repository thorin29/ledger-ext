# Changelog

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
