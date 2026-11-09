"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { CloudUpload, RefreshCw, WifiOff, CircleAlert } from "lucide-react";
import { db, isSyncing, onQueueChange, syncQueue } from "@/lib/offline";
import { useToast } from "./toast";
import { cx } from "@/lib/format";

export function useQueueStats(businessId?: string) {
  const [stats, setStats] = useState({ pending: 0, errors: 0, syncing: false });
  useEffect(() => {
    let alive = true;
    const read = async () => {
      try {
        const all = await db().queue.toArray();
        const mine = businessId ? all.filter((q) => q.business_id === businessId) : all;
        if (alive) setStats({ pending: mine.filter((q) => q.status !== "error").length, errors: mine.filter((q) => q.status === "error").length, syncing: isSyncing() });
      } catch {}
    };
    read();
    const off = onQueueChange(read);
    return () => { alive = false; off(); };
  }, [businessId]);
  return stats;
}

export function SyncIndicator({ businessId }: { businessId: string }) {
  const [online, setOnline] = useState(true);
  const stats = useQueueStats(businessId);
  const toast = useToast();

  useEffect(() => {
    const run = async () => {
      const r = await syncQueue();
      if (r.synced) toast(`${r.synced} offline sale${r.synced > 1 ? "s" : ""} synced`);
      if (r.conflicts) toast(`${r.conflicts} offline sale${r.conflicts > 1 ? "s need" : " needs"} owner review (stock or price changed)`, "error");
      if (r.failed) toast(`${r.failed} offline sale${r.failed > 1 ? "s" : ""} could not sync — open Sales to review`, "error");
    };
    const up = () => { setOnline(navigator.onLine); if (navigator.onLine) run(); };
    setOnline(navigator.onLine);
    window.addEventListener("online", up);
    window.addEventListener("offline", up);
    run();
    const t = setInterval(run, 30000);
    return () => { window.removeEventListener("online", up); window.removeEventListener("offline", up); clearInterval(t); };
  }, [toast]);

  if (online && !stats.pending && !stats.errors) return null;
  const label = !online ? (stats.pending ? `Offline · ${stats.pending} pending` : "Offline")
    : stats.errors ? `${stats.errors} failed to sync`
    : stats.syncing ? "Syncing…" : `${stats.pending} pending sync`;
  const Icon = !online ? WifiOff : stats.errors ? CircleAlert : stats.syncing ? RefreshCw : CloudUpload;
  return (
    <Link href="/app/sales?tab=queue" className={cx("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold",
      !online ? "bg-slate-800 text-white" : stats.errors ? "bg-red-100 text-red-800" : "bg-amber-100 text-amber-900")}>
      <Icon className={cx("size-3.5", stats.syncing && "animate-spin")} aria-hidden /> {label}
    </Link>
  );
}
