"use client";
import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { MessageSquarePlus, Check } from "lucide-react";
import { useBiz } from "@/components/biz";
import { useToast } from "@/components/toast";
import { Alert, Badge, Button, Card, Field, PageHeader, Spinner, Tabs, Textarea } from "@/components/ui";
import { supabase } from "@/lib/supabase";
import { cx, downloadCsv, errorMessage, fmtDateTime } from "@/lib/format";

type Kind = "bug" | "idea" | "confusing" | "praise";
const KINDS: { value: Kind; label: string; hint: string }[] = [
  { value: "bug", label: "🐞 Something broke", hint: "What did you do, what did you expect, what happened?" },
  { value: "confusing", label: "🤔 Confusing", hint: "Which screen or word was unclear?" },
  { value: "idea", label: "💡 Idea", hint: "What would make this better for a shop?" },
  { value: "praise", label: "👍 I like this", hint: "What worked well?" },
];

interface Row { id: string; kind: Kind; message: string; page: string | null; device: string | null; status: "new" | "done"; created_at: string; user_id: string | null; author: string | null }

function FeedbackInner() {
  const biz = useBiz();
  const toast = useToast();
  const from = useSearchParams().get("from") || "";
  const [kind, setKind] = useState<Kind>("idea");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(0);
  const [err, setErr] = useState<string | null>(null);

  async function send() {
    setErr(null);
    if (message.trim().length < 3) { setErr("Write a few words first."); return; }
    setBusy(true);
    const ua = typeof navigator !== "undefined" ? `${navigator.userAgent} · ${window.innerWidth}x${window.innerHeight}` : "";
    const { error } = await supabase().rpc("submit_feedback", { p_kind: kind, p_message: message, p_page: from || null, p_device: ua, p_business: biz.business.id });
    setBusy(false);
    if (error) { setErr(errorMessage(error)); return; }
    setMessage(""); setSent((n) => n + 1);
    toast("Thank you! Your feedback was sent.");
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <PageHeader title="Feedback" subtitle="Tell us what works, what's confusing and what's missing. Every message is read." />
      <Card className="space-y-3 p-4">
        <div className="grid grid-cols-2 gap-2">
          {KINDS.map((k) => (
            <button key={k.value} onClick={() => setKind(k.value)}
              className={cx("rounded-xl border p-2.5 text-left text-sm font-medium", kind === k.value ? "border-brand bg-brand-50 text-brand-800" : "border-slate-300")}>
              {k.label}
            </button>
          ))}
        </div>
        <Field label="Your feedback" hint={KINDS.find((k) => k.value === kind)?.hint}>
          <Textarea rows={5} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Type here…" />
        </Field>
        {from && <p className="text-xs text-slate-500">About the screen: {from}</p>}
        {err && <Alert tone="danger">{err}</Alert>}
        {sent > 0 && <Alert tone="success">Sent{sent > 1 ? ` (${sent} messages)` : ""}. Thanks! You can send more.</Alert>}
        <Button block size="lg" loading={busy} onClick={send}><MessageSquarePlus className="size-5" /> Send feedback</Button>
      </Card>
      {biz.isPlatformAdmin && <Inbox />}
    </div>
  );
}

/** Platform admin: every tester's feedback in one place. */
function Inbox() {
  const { business } = useBiz();
  const toast = useToast();
  const [tab, setTab] = useState<"new" | "done" | "all">("new");
  const [rows, setRows] = useState<Row[] | null>(null);
  const load = useCallback(() => {
    let q = supabase().from("feedback").select("*").order("created_at", { ascending: false }).limit(500);
    if (tab !== "all") q = q.eq("status", tab);
    q.then(({ data }) => setRows((data || []) as Row[]));
  }, [tab]);
  useEffect(load, [load]);

  async function mark(r: Row) {
    const { error } = await supabase().rpc("set_feedback_status", { p_id: r.id, p_status: r.status === "new" ? "done" : "new" });
    if (error) toast(errorMessage(error), "error"); else load();
  }

  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="font-semibold">Inbox: all feedback</h2>
        {rows && rows.length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => downloadCsv(`feedback-${new Date().toISOString().slice(0, 10)}.csv`, [
            ["date", "from", "type", "message", "screen", "device", "status"],
            ...rows.map((r) => [r.created_at, r.author || "", r.kind, r.message, r.page, r.device, r.status]),
          ])}>Export CSV</Button>
        )}
      </div>
      <Tabs value={tab} onChange={setTab} items={[{ value: "new", label: "New" }, { value: "done", label: "Done" }, { value: "all", label: "All" }]} />
      {rows === null ? <Spinner /> : rows.length === 0 ? <p className="py-6 text-center text-sm text-slate-500">Nothing here.</p> : (
        <ul className="divide-y divide-slate-100">
          {rows.map((r) => (
            <li key={r.id} className="flex gap-3 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm"><Badge tone={r.kind === "bug" ? "danger" : r.kind === "confusing" ? "warning" : r.kind === "praise" ? "success" : "brand"}>{KINDS.find((k) => k.value === r.kind)?.label}</Badge></p>
                <p className="mt-1 whitespace-pre-wrap text-sm">{r.message}</p>
                <p className="mt-1 text-xs text-slate-500">{r.author || "Unknown"} · {fmtDateTime(r.created_at, business.timezone)}{r.page ? ` · ${r.page}` : ""}</p>
              </div>
              <Button size="sm" variant={r.status === "new" ? "secondary" : "ghost"} onClick={() => mark(r)}>{r.status === "new" ? <><Check className="size-4" /> Done</> : "Reopen"}</Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export default function FeedbackPage() {
  return <Suspense><FeedbackInner /></Suspense>;
}
