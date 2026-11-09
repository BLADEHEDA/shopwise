"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { FlaskConical, ChevronRight } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { errorMessage } from "@/lib/format";
import { Alert } from "./ui";

interface DemoInfo { password: string; reset_at: string | null; accounts: { email: string; label: string }[] }

/** One-tap demo logins for testers. Shown only while a demo shop exists
 *  (select demo_reset() in Supabase creates it; demo_remove() hides this). */
export function DemoLogin() {
  const router = useRouter();
  const [info, setInfo] = useState<DemoInfo | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    supabase().rpc("demo_info").then(({ data }) => setInfo((data as DemoInfo) || null));
  }, []);
  if (!info || !info.accounts?.length) return null;

  async function go(email: string) {
    setBusy(email); setErr(null);
    await supabase().auth.signOut().catch(() => {});
    const { error } = await supabase().auth.signInWithPassword({ email, password: info!.password });
    setBusy(null);
    if (error) { setErr(errorMessage(error)); return; }
    try { localStorage.removeItem("sw-biz"); } catch {}
    router.replace("/app");
  }

  return (
    <div className="mt-8 rounded-2xl border border-brand-200 bg-brand-50 p-4">
      <p className="flex items-center gap-2 font-semibold text-brand-800"><FlaskConical className="size-5" /> Just testing? Try the demo</p>
      <p className="mt-1 text-sm text-slate-600">A sample shop with products, sales and approvals already in it. No sign-up needed. Pick a role:</p>
      <div className="mt-3 space-y-2">
        {info.accounts.map((a) => (
          <button key={a.email} onClick={() => go(a.email)} disabled={!!busy}
            className="flex w-full items-center gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-left hover:border-brand disabled:opacity-60">
            <span className="flex-1">
              <span className="block font-medium">{a.label}</span>
              <span className="block text-xs text-slate-500">{a.email} · password {info.password}</span>
            </span>
            <ChevronRight className="size-4 text-slate-400" />
            {busy === a.email && <span className="text-xs text-brand">Signing in…</span>}
          </button>
        ))}
      </div>
      {err && <Alert tone="danger" className="mt-3">{err}</Alert>}
      <p className="mt-3 text-xs text-slate-500">Demo data is shared by all testers and is reset from time to time. It is completely separate from real shops.</p>
    </div>
  );
}
