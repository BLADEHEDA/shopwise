"use client";
import { useEffect, useState } from "react";

/** Shown instead of a blank "Application error" page. After a new version
 *  is deployed, a phone may still hold pieces of the old one; reloading once
 *  fixes that, so we do it automatically. */
export function CrashScreen({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const [msg, setMsg] = useState("");
  useEffect(() => {
    const text = `${error?.name || ""} ${error?.message || ""}`;
    setMsg(text.trim());
    const stale = /ChunkLoadError|Loading chunk|Failed to fetch dynamically imported module|Importing a module script failed|Cannot find module/i.test(text);
    try {
      const k = "shopwise.reloaded-after-crash";
      if (stale && !sessionStorage.getItem(k)) {
        sessionStorage.setItem(k, "1");
        navigator.serviceWorker?.getRegistrations?.().then((rs) => rs.forEach((r) => r.update())).finally(() => location.reload());
        return;
      }
      setTimeout(() => sessionStorage.removeItem(k), 10000);
    } catch { /* ignore */ }
    console.error(error);
  }, [error]);

  async function hardReload() {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
      const rs = (await navigator.serviceWorker?.getRegistrations?.()) || [];
      await Promise.all(rs.map((r) => r.update()));
    } catch { /* ignore */ }
    location.reload();
  }

  return (
    <div className="grid min-h-dvh place-items-center bg-slate-50 p-6">
      <div className="w-full max-w-sm rounded-3xl border border-slate-200 bg-white p-6 text-center shadow-sm">
        <p className="text-lg font-semibold text-slate-900">Something went wrong on this screen</p>
        <p className="mt-1 text-sm text-slate-600">Your sales and data are safe. A sale in progress is kept and comes back after reloading.</p>
        <div className="mt-5 grid gap-2">
          <button onClick={hardReload} className="h-12 rounded-xl bg-[#3158C9] font-semibold text-white">Reload the app</button>
          <button onClick={reset} className="h-12 rounded-xl border border-slate-300 font-semibold text-slate-700">Try again</button>
          <a href="/app" className="text-sm font-medium text-[#3158C9]">Go to Home</a>
        </div>
        {msg && <p className="mt-4 break-words rounded-lg bg-slate-50 p-2 text-left font-mono text-[11px] text-slate-500">Details for support: {msg}</p>}
      </div>
    </div>
  );
}
