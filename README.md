# Ledger for Amazon

A Chrome extension that reads your Amazon orders and sends them to your own
[Ledger](https://github.com/thorin29/ledger) server, so each Amazon card charge is split by
item (groceries, household, gifts…) instead of sitting in one category.

It needs Ledger 0.108.0 or later; 0.110.0 or later lets it read only the orders it still needs.

## Install

1. Download this repo (**Code › Download ZIP**) and unzip it.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick the
   `dist` folder.
3. Click the extension's icon and connect: your Ledger address, username and password, and a
   code from **Settings › Sign-in & people › Add a phone**. Chrome asks to let it reach that
   one address.

To update, replace the `dist` folder with the new one and click the reload arrow on
`chrome://extensions`.

## How it works

- Every 6 hours while Chrome is open, and when Chrome starts, it reads **Your Orders** using
  the Amazon sign-in already in your browser. **Sync Now** runs it any time.
- Ledger tells it which Amazon charges aren't split yet. It finds those on Amazon's Your
  Payments › Transactions page, which names the order each charge paid for, and opens only those
  orders. With nothing to split, it doesn't open Amazon.
- Pages are read with plain requests. If Amazon only shows order details inside a real page, the
  sync opens one muted tab behind your current one, reads the pages there, and closes it when
  done. Closing it yourself just stops that sync.
- It starts where Ledger's last Amazon split left off (reading orders placed up to 30 days
  earlier, since Amazon charges when an order ships), reads each order's page (and the invoice
  when the order page doesn't list the card charges), reads each new product's page once for its
  category, and sends the orders to Ledger in batches. Orders already fully split are skipped.
- Ledger matches each card charge Amazon lists to a bank charge (same amount within a cent,
  within five days) and splits it into one part per item, placed by Amazon's category. Charges
  already split are left alone.
- If Amazon signs you out, asks for a captcha, or changes its pages, the sync stops and both
  the popup and Ledger tell you.

## What it reads, keeps and sends

- **Reads:** Amazon's order pages in its own background tab, and product pages with plain GET
  requests. It never clicks, buys or changes anything on Amazon and never reads your cookies.
  The `scripting` permission only lets it read pages on amazon.com.
- **Keeps from each page:** order number and date, item names, product ids, prices and
  quantities, ship dates, each card charge's date, amount and last 4 digits, and each product's
  category. Names, addresses, gift
  messages and everything else are dropped while the page is read.
- **Sends:** those fields, to your Ledger address only, over HTTPS. No analytics and no other
  servers; fonts and icons are built in.
- **Stores in Chrome:** your Ledger address, the device token, the last sync's counts, a cache
  of product categories, and salted hashes of fully split orders so they aren't read again. No
  order numbers, items or amounts. Your password is used once to connect and is never stored.
- **The token** only works for Ledger's Amazon endpoints (an `amazon`-scoped device), so it
  can't read or change anything else. **Disconnect** signs it out; you can also remove it in
  Ledger's **Settings › Sign-in & people**.

Chrome doesn't encrypt extension storage, so use disk encryption (BitLocker or FileVault) on
the computer and a Chrome profile only you use.

## When Amazon changes its pages

The popup says **Amazon changed its pages** and Ledger shows the same alert, naming the part
that broke. **Copy Page Outline** copies that page's structure with every word masked (letters
become x, digits 0) so the selectors in `src/amazon/selectors.ts` can be fixed without sharing
anything personal.

## Development

```
npm install
npm run check   # typecheck, tests, privacy check, build
```

`npm run build` writes `dist/`, which is committed so the extension can be loaded straight
from a download. Test pages in `test/fixtures` are hand-written with invented values; never
commit a saved real page. `npm run privacy` fails on real-looking order numbers, card digits,
emails, phone numbers and street addresses. In GitHub, an optional `PRIVATE_DENYLIST` secret
(comma-separated SHA-256 hashes of lowercase words) blocks words you name without listing them.
