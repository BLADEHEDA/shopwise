"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { ChevronRight, Users, Palette, History, Plus, LogOut } from "lucide-react";
import { useBiz } from "@/components/biz";
import { useToast } from "@/components/toast";
import { Alert, Badge, Button, Card, Field, Input, PageHeader, PasswordInput, Select } from "@/components/ui";
import { supabase } from "@/lib/supabase";
import { errorMessage, ROLE_LABEL, uuid } from "@/lib/format";
import type { PaymentMethod } from "@/lib/types";

export default function SettingsPage() {
  const biz = useBiz();
  const { business, isOwner } = biz;
  const toast = useToast();
  const [name, setName] = useState(biz.profile?.full_name || "");
  const [phone, setPhone] = useState(biz.profile?.phone || "");
  const [b, setB] = useState({ name: business.name, phone: business.phone || "", address: business.address || "", receipt_footer: business.receipt_footer || "", require_shift: business.require_shift, logo_url: business.logo_url || "" });
  const [newSection, setNewSection] = useState("");
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [newMethod, setNewMethod] = useState({ name: "", kind: "mobile_money" });
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    supabase().from("payment_methods").select("*").eq("business_id", business.id).order("sort").then(({ data }) => setMethods((data || []) as PaymentMethod[]));
  }, [business.id]);

  async function run(key: string, fn: () => PromiseLike<{ error: unknown }>, ok: string) {
    setBusy(key);
    const { error } = await fn();
    setBusy(null);
    if (error) { toast(errorMessage(error), "error"); return false; }
    toast(ok); await biz.refresh(); return true;
  }

  async function uploadLogo(file: File) {
    const path = `${business.id}/logo-${uuid()}.${(file.name.split(".").pop() || "png").toLowerCase()}`;
    const { error } = await supabase().storage.from("shopwise").upload(path, file, { contentType: file.type });
    if (error) { toast(errorMessage(error), "error"); return; }
    setB({ ...b, logo_url: supabase().storage.from("shopwise").getPublicUrl(path).data.publicUrl });
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader title="Settings" />

      <Card className="space-y-3 p-4">
        <h2 className="font-semibold">My account</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Full name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Phone"><Input value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
        </div>
        <p className="text-sm text-slate-500">{biz.session.user.email} · {ROLE_LABEL[biz.role]}</p>
        <div className="flex gap-2">
          <Button variant="secondary" loading={busy === "me"} onClick={() => run("me", () => supabase().from("profiles").update({ full_name: name, phone }).eq("user_id", biz.userId), "Profile saved")}>Save</Button>
          <Button variant="ghost" onClick={() => supabase().auth.signOut()}><LogOut className="size-4" /> Sign out</Button>
        </div>
      </Card>

      <LoginSecurity />

      {isOwner && (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            {[
              { href: "/app/settings/team", label: "Team & permissions", sub: "Invite partners and staff", icon: Users, show: true },
              { href: "/app/settings/audit", label: "Audit log", sub: "Who changed what", icon: History, show: true },
              { href: "/app/settings/brand", label: "Product branding", sub: "Platform admin only", icon: Palette, show: biz.isPlatformAdmin },
            ].filter((x) => x.show).map((x) => (
              <Link key={x.href} href={x.href}>
                <Card className="flex items-center gap-3 p-4 hover:border-brand-200 hover:bg-brand-50">
                  <x.icon className="size-5 text-brand" />
                  <div className="flex-1"><p className="font-medium">{x.label}</p><p className="text-xs text-slate-500">{x.sub}</p></div>
                  <ChevronRight className="size-4 text-slate-400" />
                </Card>
              </Link>
            ))}
          </div>

          <Card className="space-y-3 p-4">
            <h2 className="font-semibold">Business profile</h2>
            <div className="flex items-center gap-4">
              <label className="grid size-16 cursor-pointer place-items-center overflow-hidden rounded-2xl border-2 border-dashed border-slate-300 text-xs text-slate-500">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {b.logo_url ? <img src={b.logo_url} alt="" className="size-full object-contain" /> : "Logo"}
                <input type="file" accept="image/*" className="sr-only" onChange={(e) => e.target.files?.[0] && uploadLogo(e.target.files[0])} />
              </label>
              <p className="text-sm text-slate-500">Your logo appears on receipts.</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Business name"><Input value={b.name} onChange={(e) => setB({ ...b, name: e.target.value })} /></Field>
              <Field label="Phone"><Input value={b.phone} onChange={(e) => setB({ ...b, phone: e.target.value })} /></Field>
              <Field label="Address" className="sm:col-span-2"><Input value={b.address} onChange={(e) => setB({ ...b, address: e.target.value })} /></Field>
              <Field label="Receipt footer" className="sm:col-span-2"><Input value={b.receipt_footer} onChange={(e) => setB({ ...b, receipt_footer: e.target.value })} /></Field>
            </div>
            <Field label="Shift policy">
              <Select value={b.require_shift ? "block" : "flag"} onChange={(e) => setB({ ...b, require_shift: e.target.value === "block" })}>
                <option value="block">Staff must clock in before selling</option>
                <option value="flag">Allow sales without a shift, but flag them</option>
              </Select>
            </Field>
            <p className="text-xs text-slate-500">Currency: {business.currency === "XAF" ? "FCFA (XAF)" : business.currency} · Timezone: {business.timezone}</p>
            <Button loading={busy === "biz"} onClick={() => run("biz", () => supabase().from("businesses").update({ ...b, logo_url: b.logo_url || null }).eq("id", business.id), "Business saved")}>Save business</Button>
          </Card>

          <Card className="space-y-3 p-4">
            <h2 className="font-semibold">Sections</h2>
            <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
              {biz.sections.map((s) => (
                <li key={s.id} className="flex items-center justify-between px-3 py-2.5">
                  <span className="font-medium">{s.name} {!s.active && <Badge>Inactive</Badge>}</span>
                  <Button size="sm" variant="ghost" onClick={() => run("sec" + s.id, () => supabase().from("sections").update({ active: !s.active }).eq("id", s.id), s.active ? "Section deactivated" : "Section activated")}>
                    {s.active ? "Deactivate" : "Activate"}
                  </Button>
                </li>
              ))}
            </ul>
            <div className="flex gap-2">
              <Input placeholder="New section name" value={newSection} onChange={(e) => setNewSection(e.target.value)} />
              <Button variant="secondary" disabled={!newSection.trim()} loading={busy === "newsec"} onClick={async () => {
                if (await run("newsec", () => supabase().from("sections").insert({ business_id: business.id, name: newSection.trim() }), "Section added")) setNewSection("");
              }}><Plus className="size-4" /> Add</Button>
            </div>
          </Card>

          <Card className="space-y-3 p-4">
            <h2 className="font-semibold">Payment methods</h2>
            <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
              {methods.map((m) => (
                <li key={m.id} className="flex items-center justify-between px-3 py-2.5">
                  <span className="font-medium">{m.name} {!m.active && <Badge>Off</Badge>}</span>
                  <Button size="sm" variant="ghost" onClick={async () => {
                    const { error } = await supabase().from("payment_methods").update({ active: !m.active }).eq("id", m.id);
                    if (error) toast(errorMessage(error), "error"); else setMethods(methods.map((x) => (x.id === m.id ? { ...x, active: !x.active } : x)));
                  }}>{m.active ? "Turn off" : "Turn on"}</Button>
                </li>
              ))}
            </ul>
            <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto]">
              <Input placeholder="e.g. Bank transfer" value={newMethod.name} onChange={(e) => setNewMethod({ ...newMethod, name: e.target.value })} />
              <Select value={newMethod.kind} onChange={(e) => setNewMethod({ ...newMethod, kind: e.target.value })}>
                <option value="mobile_money">Mobile money</option><option value="bank">Bank</option><option value="card">Card</option><option value="cash">Cash</option><option value="other">Other</option>
              </Select>
              <Button variant="secondary" disabled={!newMethod.name.trim()} onClick={async () => {
                const { data, error } = await supabase().from("payment_methods").insert({ business_id: business.id, name: newMethod.name.trim(), kind: newMethod.kind, sort: methods.length + 1 }).select().single();
                if (error) toast(errorMessage(error), "error"); else { setMethods([...methods, data as PaymentMethod]); setNewMethod({ name: "", kind: "mobile_money" }); }
              }}><Plus className="size-4" /> Add</Button>
            </div>
          </Card>
        </>
      )}
      {!isOwner && <Alert tone="info">Business settings, team and permissions are managed by the business owner.</Alert>}
    </div>
  );
}

/** Change login email / password. Both require the current password, so a
 *  phone left unlocked can't be used to take over the account. */
function LoginSecurity() {
  const biz = useBiz();
  const toast = useToast();
  const email = biz.session.user.email || "";
  const [mode, setMode] = useState<"none" | "password" | "email">("none");
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reset = () => { setMode("none"); setCurrent(""); setNext(""); setConfirm(""); setNewEmail(""); setErr(null); };

  async function verifyCurrent(): Promise<boolean> {
    const { error } = await supabase().auth.signInWithPassword({ email, password: current });
    if (error) { setErr("Your current password is not correct."); return false; }
    return true;
  }

  async function savePassword() {
    setErr(null);
    if (next.length < 8) return setErr("The new password must have at least 8 characters.");
    if (next !== confirm) return setErr("The two new passwords don't match.");
    if (next === current) return setErr("Choose a password different from the current one.");
    setBusy(true);
    try {
      if (!(await verifyCurrent())) return;
      const { error } = await supabase().auth.updateUser({ password: next });
      if (error) { setErr(errorMessage(error)); return; }
      toast("Password changed. Use the new one next time you sign in.");
      reset();
    } finally { setBusy(false); }
  }

  async function saveEmail() {
    setErr(null);
    const e = newEmail.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return setErr("Enter a valid email address.");
    if (e === email.toLowerCase()) return setErr("That is already your email.");
    setBusy(true);
    try {
      if (!(await verifyCurrent())) return;
      const { data, error } = await supabase().auth.updateUser({ email: e }, { emailRedirectTo: `${window.location.origin}/app/settings` });
      if (error) { setErr(errorMessage(error)); return; }
      if (data.user?.email?.toLowerCase() === e) {
        toast(`Login email changed to ${e}`);
        await biz.refresh();
      } else {
        toast(`Check ${e} (and your current inbox) and click the confirmation link to finish.`);
      }
      reset();
    } finally { setBusy(false); }
  }

  return (
    <Card className="space-y-3 p-4">
      <h2 className="font-semibold">Login & security</h2>
      <p className="text-sm text-slate-600">You sign in with <b>{email}</b>. Changing your email or password always asks for your current password.</p>
      {mode === "none" && (
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setMode("password")}>Change password</Button>
          <Button variant="secondary" onClick={() => setMode("email")}>Change login email</Button>
        </div>
      )}
      {mode !== "none" && (
        <div className="space-y-3 rounded-xl border border-slate-200 p-3">
          {mode === "email" && (
            <Field label="New login email" hint="e.g. a shop email like frankonic.store@gmail.com, not a personal one">
              <Input type="email" autoComplete="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} />
            </Field>
          )}
          {mode === "password" && (
            <>
              <Field label="New password" hint="At least 8 characters"><PasswordInput autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} /></Field>
              <Field label="Repeat new password"><PasswordInput autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></Field>
            </>
          )}
          <Field label="Current password"><PasswordInput autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} /></Field>
          {err && <Alert tone="danger">{err}</Alert>}
          <div className="flex gap-2">
            <Button loading={busy} onClick={mode === "password" ? savePassword : saveEmail}>{mode === "password" ? "Save new password" : "Change email"}</Button>
            <Button variant="ghost" onClick={reset}>Cancel</Button>
          </div>
        </div>
      )}
    </Card>
  );
}
