#!/usr/bin/env node
// Fails if anything in the repo looks like real personal data: order numbers, card digits,
// emails, phone numbers, street addresses. Test data must be invented (order numbers like
// 111-0000000-0000001, card digits 0000, example.com).
//
// PRIVATE_DENYLIST (optional, a GitHub Actions secret) is a comma-separated list of SHA-256
// hashes of words or short phrases that must never appear (names, a domain, a bank). Only
// hashes are kept, so the list itself reveals nothing. Matching is on lowercased words and
// two- and three-word phrases.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const SKIP_DIRS = new Set(["node_modules", ".git", "licenses"]);
const TEXT = /\.(ts|mjs|js|json|html|css|md|yml|yaml|txt)$/;
const SKIP_FILES = new Set(["package-lock.json"]);

const rules = [
  { name: "order number", rx: /\b\d{3}-\d{7}-\d{7}\b/g, allow: (m) => /^\d{3}-0000000-\d{7}$/.test(m) },
  { name: "card digits", rx: /ending in\s*(\d{4})/gi, allow: (m) => /0000$/.test(m) },
  { name: "card number", rx: /\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}\b/g, allow: (m) => /^[0 -]+$/.test(m) },
  { name: "email", rx: /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, allow: (m) => /@([\w-]+\.)*(example\.(com|org|net)|users\.noreply\.github\.com)$/i.test(m) || /^noreply@/.test(m) },
  { name: "phone number", rx: /\(?\b\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/g, allow: (m) => /555/.test(m) || /^0{3}/.test(m.replace(/\D/g, "")) },
  {
    name: "street address",
    rx: /\b\d{1,5}\s+(?:[A-Z][a-z]+\s){1,3}(?:Street|St|Avenue|Ave|Road|Rd|Drive|Dr|Lane|Ln|Way|Blvd|Boulevard|Court|Ct|Circle|Cir|Parkway|Pkwy|Trail|Trl)\b/g,
    allow: (m) => /Invented|Example/.test(m),
  },
];

const hashes = new Set(
  (process.env.PRIVATE_DENYLIST ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => /^[0-9a-f]{64}$/.test(h)),
);
const sha = (s) => createHash("sha256").update(s).digest("hex");

function* files(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (TEXT.test(name) && !SKIP_FILES.has(name)) yield path;
  }
}

const problems = [];
for (const path of files(root)) {
  if (path === new URL(import.meta.url).pathname) continue;
  const text = readFileSync(path, "utf8");
  const where = (index) => `${relative(root, path)}:${text.slice(0, index).split("\n").length}`;
  for (const rule of rules) {
    for (const m of text.matchAll(rule.rx)) if (!rule.allow(m[0])) problems.push(`${where(m.index)}  ${rule.name}`);
  }
  if (hashes.size) {
    const words = [...text.toLowerCase().matchAll(/[a-z0-9][a-z0-9.'’-]*[a-z0-9]|[a-z0-9]/g)];
    for (let i = 0; i < words.length; i++) {
      for (let n = 1; n <= 3 && i + n <= words.length; n++) {
        const phrase = words.slice(i, i + n).map((w) => w[0]).join(" ");
        if (hashes.has(sha(phrase))) problems.push(`${where(words[i].index)}  private word`);
      }
    }
  }
}

if (problems.length) {
  console.error("Privacy check failed. Replace these with invented values:\n" + [...new Set(problems)].map((p) => "  " + p).join("\n"));
  process.exit(1);
}
console.log(`Privacy check passed${hashes.size ? ` (with ${hashes.size} private words)` : ""}.`);
