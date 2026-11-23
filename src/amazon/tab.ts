/**
 * Amazon now unlocks order details only inside a real page (its own scripts decrypt them), so
 * order pages are opened in one background tab, read once they've finished loading, and the
 * tab is closed when the sync ends. The page is read on this computer; only the parsed fields
 * ever leave it, and only to Ledger.
 */

export type PageKind = "list" | "order" | "invoice" | "transactions";

export class TabClosedError extends Error {
  constructor() {
    super("The sync tab was closed");
    this.name = "TabClosedError";
  }
}

const LOAD_TIMEOUT_MS = 30_000;
const READY_TIMEOUT_MS = 20_000;
const POLL_MS = 500;

let tabId: number | null = null;
/** Set when the person closes the sync tab or clicks Stop: no new tab opens until the next sync. */
let cancelled = false;

chrome.tabs.onRemoved.addListener((removed) => {
  if (removed === tabId) {
    tabId = null;
    cancelled = true;
  }
});

/** A new sync: forget an earlier Stop. */
export function resetTab(): void {
  cancelled = false;
}

/** Stop: close the tab and refuse to open another until the next sync. */
export async function stopTab(): Promise<void> {
  cancelled = true;
  await closeTab();
}

/** Throws if the sync was stopped, so plain requests stop too. */
export function checkStopped(): void {
  if (cancelled) throw new TabClosedError();
}

/** Runs inside the Amazon page. Says whether Amazon has finished filling it in, and returns it. */
function probe(kind: PageKind): { ready: boolean; html: string; url: string } {
  const d = document;
  const has = (s: string) => !!d.querySelector(s);
  const text = d.body?.innerText ?? "";
  let ready = d.readyState === "complete";
  if (has('form[name="signIn"], #ap_email, #ap_password, #captchacharacters')) ready = true;
  else if (kind === "list") {
    // Every order box unlocked (has content), or no orders this year.
    const locked = [...d.querySelectorAll(".csd-encrypted-sensitive")].filter((el) => !el.children.length && !(el.textContent ?? "").trim());
    const cards = d.querySelectorAll(".order-card, .js-order-card").length;
    ready = ready && ((cards > 0 && locked.length === 0) || /0 orders placed|haven't placed|have not placed/i.test(text));
  } else if (kind === "transactions") {
    ready = ready && (/Order #|no transactions|you have no/i.test(text) || has("form[name*='signIn']"));
  } else if (kind === "order") {
    ready = ready && (has('[data-component="purchasedItems"], .yohtmlc-item, [data-component="orderDate"], [data-component="errorbanner"]') || /ordered on|order placed/i.test(text));
  }
  return { ready, html: d.documentElement.outerHTML, url: location.href };
}

function waitForLoad(id: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, LOAD_TIMEOUT_MS);
    function done() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      resolve();
    }
    function onUpdated(changed: number, info: chrome.tabs.TabChangeInfo) {
      if (changed === id && info.status === "complete") done();
    }
    function onRemoved(removed: number) {
      if (removed !== id) return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      reject(new TabClosedError());
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
  });
}

async function tabExists(id: number): Promise<boolean> {
  try {
    await chrome.tabs.get(id);
    return true;
  } catch {
    return false;
  }
}

/** The sync tab: behind the current tab in the last window used, or a minimized window if none is open. */
async function openTab(url: string): Promise<number> {
  checkStopped();
  if (tabId !== null && (await tabExists(tabId))) {
    await chrome.tabs.update(tabId, { url });
    return tabId;
  }
  let windowId: number | undefined;
  try {
    windowId = (await chrome.windows.getLastFocused({ windowTypes: ["normal"] })).id;
  } catch {
    windowId = undefined;
  }
  if (windowId === undefined) {
    const win = await chrome.windows.create({ url, state: "minimized", focused: false });
    tabId = win.tabs?.[0]?.id ?? null;
  } else {
    const tab = await chrome.tabs.create({ url, active: false, windowId });
    tabId = tab.id ?? null;
  }
  if (tabId === null) throw new TabClosedError();
  await chrome.tabs.update(tabId, { muted: true }).catch(() => undefined);
  return tabId;
}

/** Opens `url` in the sync tab, waits until Amazon has filled it in (or 20 s pass), and returns the page. */
export async function readInTab(url: string, kind: PageKind): Promise<{ html: string; url: string }> {
  const id = await openTab(url);
  await waitForLoad(id);
  const started = Date.now();
  for (;;) {
    let result: { ready: boolean; html: string; url: string } | undefined;
    try {
      const [frame] = await chrome.scripting.executeScript({ target: { tabId: id }, func: probe, args: [kind] });
      result = frame?.result as typeof result;
    } catch {
      if (!(await tabExists(id))) throw new TabClosedError();
      // Mid-navigation (a redirect): try again shortly.
    }
    if (result && (result.ready || Date.now() - started > READY_TIMEOUT_MS)) return { html: result.html, url: result.url };
    if (!result && Date.now() - started > READY_TIMEOUT_MS) throw new Error("Couldn't read the page");
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

export async function closeTab(): Promise<void> {
  if (tabId === null) return;
  const id = tabId;
  tabId = null;
  await chrome.tabs.remove(id).catch(() => undefined);
}

/** Runs inside the page: clicks the "Next page" button if there is one. */
function clickNext(): boolean {
  const byName = document.querySelector<HTMLElement>('input[name*="NextPage"], input[name*="nextPage"]');
  const byText = [...document.querySelectorAll<HTMLElement>("a, button, span.a-button-text, input[type=submit]")].find((el) =>
    /^next( page)?\s*(→|›)?$/i.test((el.textContent || (el as HTMLInputElement).value || "").trim()),
  );
  const target = byName ?? byText;
  if (!target || target.closest(".a-button-disabled, .a-disabled, [aria-disabled='true']")) return false;
  (target.closest("span.a-button")?.querySelector<HTMLElement>("input, a, button") ?? target).click();
  return true;
}

function fingerprint(): string {
  return (document.body?.innerText ?? "").slice(0, 3000);
}

/**
 * Clicks "Next page" in the sync tab and waits until the page shows something new. Returns the
 * new page, or null when there's no next page.
 */
export async function nextPageInTab(kind: PageKind): Promise<{ html: string; url: string } | null> {
  checkStopped();
  if (tabId === null) return null;
  const id = tabId;
  const [before] = await chrome.scripting.executeScript({ target: { tabId: id }, func: fingerprint });
  const [clicked] = await chrome.scripting.executeScript({ target: { tabId: id }, func: clickNext });
  if (!clicked?.result) return null;
  const started = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    if (!(await tabExists(id))) throw new TabClosedError();
    try {
      const [now] = await chrome.scripting.executeScript({ target: { tabId: id }, func: fingerprint });
      const [frame] = await chrome.scripting.executeScript({ target: { tabId: id }, func: probe, args: [kind] });
      const result = frame?.result as { ready: boolean; html: string; url: string } | undefined;
      if (result && now?.result !== before?.result && result.ready) return { html: result.html, url: result.url };
    } catch {
      // Mid-navigation: keep waiting.
    }
    if (Date.now() - started > READY_TIMEOUT_MS) return null;
  }
}
