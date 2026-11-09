"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, X } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { AuthLayout } from "@/components/auth-layout";
import { Alert, Button, Field, Input } from "@/components/ui";
import { errorMessage } from "@/lib/format";

export default function Onboarding() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [sections, setSections] = useState<string[]>(["Electronics", "Components"]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    supabase().auth.getSession().then(({ data }) => { if (!data.session) router.replace("/login"); });
  }, [router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    const { data, error } = await supabase().rpc("create_business", {
      p_name: name, p_sections: sections.map((s) => s.trim()).filter(Boolean), p_phone: phone || null, p_address: address || null,
    });
    setBusy(false);
    if (error) { setErr(errorMessage(error)); return; }
    try { localStorage.setItem("sw-biz", data as string); } catch {}
    router.replace("/app?welcome=1");
  }

  return (
    <AuthLayout title="Set up your business" subtitle="You can change all of this later in Settings.">
      <form onSubmit={submit} className="space-y-4">
        {err && <Alert tone="danger">{err}</Alert>}
        <Field label="Business name"><Input required placeholder="e.g. Frankonic Store" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Phone (on receipts)"><Input inputMode="tel" placeholder="+237 6XX XXX XXX" value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
        <Field label="Address (on receipts)"><Input placeholder="e.g. Molyko, Buea" value={address} onChange={(e) => setAddress(e.target.value)} /></Field>
        <div>
          <p className="mb-1.5 text-sm font-medium text-slate-700">Sections</p>
          <p className="mb-2 text-xs text-slate-500">Departments or partner units. Each can have its own owner, stock and profit.</p>
          <div className="space-y-2">
            {sections.map((s, i) => (
              <div key={i} className="flex gap-2">
                <Input value={s} onChange={(e) => setSections(sections.map((x, j) => (j === i ? e.target.value : x)))} aria-label={`Section ${i + 1}`} />
                {sections.length > 1 && (
                  <Button type="button" variant="ghost" onClick={() => setSections(sections.filter((_, j) => j !== i))} aria-label="Remove section"><X className="size-4" /></Button>
                )}
              </div>
            ))}
            <Button type="button" variant="secondary" size="sm" onClick={() => setSections([...sections, ""])}><Plus className="size-4" /> Add section</Button>
          </div>
        </div>
        <Button type="submit" block size="lg" loading={busy}>Create business</Button>
        <p className="text-xs text-slate-500">Cash, MTN Mobile Money and Orange Money are set up for you. Currency: FCFA · Timezone: Africa/Douala.</p>
      </form>
    </AuthLayout>
  );
}
