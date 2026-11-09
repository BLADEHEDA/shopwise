// Money helpers. All client-side arithmetic is done in integer minor units
// (cents) to avoid binary floating-point errors. The database (numeric) is
// the source of truth; these are for display and live totals only.

export type Minor = number; // integer, 1/100 of the currency unit

export function toMinor(value: number | string | null | undefined): Minor {
  if (value === null || value === undefined || value === "") return 0;
  const s = String(value).replace(/[\s,]/g, "");
  if (!/^-?\d*(\.\d*)?$/.test(s)) return NaN;
  const [whole, frac = ""] = s.split(".");
  const sign = whole.startsWith("-") ? -1 : 1;
  const w = Math.abs(parseInt(whole || "0", 10)) || 0;
  const f = parseInt((frac + "00").slice(0, 2), 10) || 0;
  return sign * (w * 100 + f);
}

export function fromMinor(m: Minor): number {
  return m / 100;
}

/** Decimal string for sending to the database, e.g. 1234.5 -> "1234.50" */
export function minorToDecimal(m: Minor): string {
  const sign = m < 0 ? "-" : "";
  const a = Math.abs(Math.round(m));
  return `${sign}${Math.floor(a / 100)}.${String(a % 100).padStart(2, "0")}`;
}

export function currencyLabel(code?: string | null): string {
  if (!code || code === "XAF" || code === "XOF") return "FCFA";
  return code;
}

const nf0 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function fmtNumber(value: number | string | null | undefined): string {
  const m = toMinor(value ?? 0);
  if (Number.isNaN(m)) return "—";
  return m % 100 === 0 ? nf0.format(m / 100) : nf2.format(m / 100);
}

// Currencies with no sub-unit in everyday use: show whole numbers.
const WHOLE = new Set(["XAF", "XOF", "FCFA", "NGN", "JPY"]);

export function fmtMoney(value: number | string | null | undefined, currency?: string | null): string {
  if (value === null || value === undefined) return "—";
  const code = currency || "XAF";
  if (WHOLE.has(code)) {
    const m = toMinor(value);
    if (Number.isNaN(m)) return "—";
    return `${nf0.format(Math.round(m / 100))} ${currencyLabel(code)}`;
  }
  return `${fmtNumber(value)} ${currencyLabel(code)}`;
}

export function fmtMinor(m: Minor, currency?: string | null): string {
  return fmtMoney(fromMinor(m), currency);
}
