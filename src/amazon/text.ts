/** Amazon's dates and amounts, as written on its pages. Pure. */

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH = "(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?";

const pad = (n: number) => String(n).padStart(2, "0");
const monthIndex = (name: string) => MONTHS.findIndex((m) => m.startsWith(name.toLowerCase().replace(".", "").slice(0, 3)));

/** "November 19, 2026" or "Nov 19, 2026" → "2026-11-19". The first date in the text wins. */
export function fullDate(text: string): string | null {
  const m = new RegExp(`${MONTH}\\s+(\\d{1,2}),?\\s+(\\d{4})`, "i").exec(text);
  if (!m) return null;
  const month = monthIndex(m[1]!);
  const day = Number(m[2]);
  if (month < 0 || day < 1 || day > 31) return null;
  return `${m[3]}-${pad(month + 1)}-${pad(day)}`;
}

/**
 * "Delivered November 20" or "Shipped Nov 19" (no year) → the date on or after `after`,
 * so a December order delivered in January gets the new year.
 */
export function shortDate(text: string, after: string): string | null {
  const full = fullDate(text);
  if (full) return full;
  const m = new RegExp(`${MONTH}\\s+(\\d{1,2})(?!\\d|,?\\s*\\d{4})`, "i").exec(text);
  if (!m) return null;
  const month = monthIndex(m[1]!);
  const day = Number(m[2]);
  if (month < 0 || day < 1 || day > 31) return null;
  let year = Number(after.slice(0, 4));
  let iso = `${year}-${pad(month + 1)}-${pad(day)}`;
  if (iso < after) iso = `${++year}-${pad(month + 1)}-${pad(day)}`;
  return iso;
}

/** "$1,234.56" → 123456. Null when there's no dollar amount. */
export function cents(text: string): number | null {
  const m = /\$\s*([\d,]+)(?:\.(\d{2}))?/.exec(text);
  if (!m) return null;
  return Number(m[1]!.replace(/,/g, "")) * 100 + Number(m[2] ?? 0);
}

/** Amazon's order numbers: 3-7-7 digits, or D01-… for digital orders. */
export const ORDER_ID = /\b(\d{3}-\d{7}-\d{7}|D\d{2}-\d{7}-\d{7})\b/;

export const clean = (text: string | null | undefined): string => (text ?? "").replace(/\s+/g, " ").trim();
