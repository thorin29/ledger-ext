/**
 * Parses Amazon pages for the service worker, which has no DOM. DOMParser builds an inert
 * document: Amazon's scripts don't run and nothing loads. Only the parsed fields go back.
 */

import { blocked, chargesIn, isCancelled, outline, ParseError, parseOrderDetails, parseOrderList } from "./amazon/parse";

type Msg = { target: "offscreen"; kind: "list" | "order" | "charges" | "outline"; html: string; url: string; orderId?: string };

function handle(msg: Msg): unknown {
  const doc = new DOMParser().parseFromString(msg.html, "text/html");
  const stop = blocked(doc, msg.url);
  if (stop) return { blocked: stop };
  try {
    switch (msg.kind) {
      case "list":
        return { ok: parseOrderList(doc, msg.url) };
      case "order":
        if (isCancelled(doc)) return { skip: true };
        return { ok: parseOrderDetails(doc, msg.orderId ?? "") };
      case "charges":
        return { ok: chargesIn(doc) };
      case "outline":
        return { outline: outline(doc) };
    }
  } catch (e) {
    if (e instanceof ParseError) return { failed: e.section };
    return { failed: msg.kind === "list" ? "orders_list" : "order_items" };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== chrome.runtime.id || msg?.target !== "offscreen") return false;
  reply(handle(msg as Msg));
  return false;
});
