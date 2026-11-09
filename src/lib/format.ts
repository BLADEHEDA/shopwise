export const ROLE_LABEL: Record<string, string> = {
  owner: "Super admin",
  section_owner: "Shop owner",
  manager: "Manager",
  staff: "Shopkeeper",
  accountant: "Accountant (read-only)",
};

export function fmtDateTime(iso: string | null | undefined, tz = "Africa/Douala"): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
  }).format(new Date(iso));
}

export function fmtDate(iso: string | null | undefined, tz = "Africa/Douala"): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, day: "2-digit", month: "short", year: "numeric" }).format(new Date(iso));
}

export function fmtTime(iso: string | null | undefined, tz = "Africa/Douala"): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}

/** YYYY-MM-DD for "today" in the business timezone */
export function todayIn(tz = "Africa/Douala", offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86400000);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  return parts; // en-CA gives YYYY-MM-DD
}

export function startOfMonthIn(tz = "Africa/Douala"): string {
  return todayIn(tz).slice(0, 8) + "01";
}

export function duration(fromIso: string, toIso?: string | null): string {
  const ms = (toIso ? new Date(toIso).getTime() : Date.now()) - new Date(fromIso).getTime();
  const m = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
}

export function receiptLabel(no: number | string | null | undefined): string {
  if (no === null || no === undefined) return "Pending";
  return `#${String(no).padStart(5, "0")}`;
}

export function errorMessage(e: unknown): string {
  if (!e) return "Something went wrong";
  const msg = typeof e === "string" ? e : (e as { message?: string }).message || "Something went wrong";
  if (/failed to fetch|network|load failed|fetch failed|aborted|timeout/i.test(msg)) {
    return "No connection. Check your internet and try again.";
  }
  if (/jwt|token is expired|invalid claim/i.test(msg)) return "Your session expired. Please sign in again.";
  if (/permission denied|row-level security/i.test(msg)) {
    return "You don't have permission to do this. Ask the business owner.";
  }
  return msg;
}

export function isNetworkError(e: unknown): boolean {
  const msg = typeof e === "string" ? e : (e as { message?: string })?.message || "";
  return /failed to fetch|network|load failed|fetch failed|timeout|aborterror|aborted/i.test(msg) || (typeof navigator !== "undefined" && !navigator.onLine);
}

export function cx(...c: (string | false | null | undefined)[]): string {
  return c.filter(Boolean).join(" ");
}

export function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  // fallback for very old browsers
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function downloadCsv(filename: string, rows: (string | number | null | undefined)[][]) {
  const csv = rows
    .map((r) => r.map((v) => {
      const s = v === null || v === undefined ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(","))
    .join("\n");
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Shared demo logins (see migration 0004) */
export function isDemoEmail(email?: string | null): boolean {
  return !!email && /^demo\.[a-z]+@example\.com$/i.test(email);
}
