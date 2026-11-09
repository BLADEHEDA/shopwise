"use client";
import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { AuthLayout } from "@/components/auth-layout";
import { Alert, Button, Field, Input, PasswordInput, Spinner } from "@/components/ui";
import { errorMessage, ROLE_LABEL } from "@/lib/format";

interface Inv { business_name: string; email: string; role: string; expired: boolean; accepted: boolean; revoked: boolean }

function InviteInner() {
  const router = useRouter();
  const token = useSearchParams().get("t") || "";
  const [inv, setInv] = useState<Inv | null | undefined>(undefined);
  const [me, setMe] = useState<string | null | undefined>(undefined);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [existing, setExisting] = useState(false);
  const [checkEmail, setCheckEmail] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const sb = supabase();
    sb.rpc("get_invitation", { p_token: token }).then(({ data }) => setInv((data as Inv) || null));
    sb.auth.getSession().then(({ data }) => setMe(data.session?.user.email?.toLowerCase() || null));
  }, [token]);

  async function accept() {
    const { data, error } = await supabase().rpc("accept_invitation", { p_token: token });
    if (error) { setErr(errorMessage(error)); return false; }
    try { localStorage.setItem("sw-biz", data as string); } catch {}
    router.replace("/app?joined=1");
    return true;
  }

  // One step: create the account (or sign in if it already exists), then join.
  async function join(e: React.FormEvent) {
    e.preventDefault();
    if (!inv) return;
    setErr(null);
    if (!existing && !name.trim()) { setErr("Type your full name."); return; }
    if (password.length < 8) { setErr("Choose a password of at least 8 characters."); return; }
    setBusy(true);
    const sb = supabase();
    try {
      if (!existing) {
        const { data, error } = await sb.auth.signUp({
          email: inv.email, password,
          options: { data: { full_name: name.trim() }, emailRedirectTo: `${window.location.origin}/invite?t=${token}` },
        });
        if (error && /already|registered|exists/i.test(error.message)) {
          setExisting(true);
          setErr("You already have an account with this email. Enter your existing password to join.");
          return;
        }
        if (error) { setErr(errorMessage(error)); return; }
        if (!data.session) { setCheckEmail(true); return; }
      } else {
        const { error } = await sb.auth.signInWithPassword({ email: inv.email, password });
        if (error) { setErr(error.message === "Invalid login credentials" ? "Wrong password. Use “Forgot password” on the sign-in page if needed." : errorMessage(error)); return; }
      }
      await accept();
    } finally { setBusy(false); }
  }

  if (inv === undefined || me === undefined) return <Spinner />;
  if (!inv) return <Alert tone="danger" title="Invitation not found">Ask the person who invited you to send a new link.</Alert>;
  if (inv.revoked || inv.expired || inv.accepted) {
    return (
      <div className="space-y-3">
        <Alert tone="warning" title={inv.accepted ? "This invitation was already used" : inv.expired ? "This invitation has expired" : "This invitation was cancelled"}>
          {inv.accepted ? "If it was you, just sign in." : "Ask the person who invited you for a new link."}
        </Alert>
        {inv.accepted && <Link href="/login"><Button block size="lg">Sign in</Button></Link>}
      </div>
    );
  }

  const header = (
    <div className="rounded-2xl border border-slate-200 p-4">
      <p className="text-sm text-slate-500">You&apos;ve been invited to join</p>
      <p className="text-xl font-bold">{inv.business_name}</p>
      <p className="mt-1 text-sm">as <b>{ROLE_LABEL[inv.role] || inv.role}</b></p>
    </div>
  );

  if (checkEmail) {
    return <div className="space-y-4">{header}<Alert tone="success" title="Almost done: check your email">We sent a confirmation link to <b>{inv.email}</b>. Open it on this phone and you&apos;ll join automatically.</Alert></div>;
  }

  // already signed in on this device
  if (me) {
    return (
      <div className="space-y-4">
        {header}
        {err && <Alert tone="danger">{err}</Alert>}
        {me === inv.email ? (
          <Button block size="lg" loading={busy} onClick={async () => { setBusy(true); await accept(); setBusy(false); }}>Join {inv.business_name}</Button>
        ) : (
          <Alert tone="warning" title={`You're signed in as ${me}`}>
            This invitation is for {inv.email}.{" "}
            <button className="font-semibold underline" onClick={() => supabase().auth.signOut().then(() => setMe(null))}>Sign out</button> to continue.
          </Alert>
        )}
      </div>
    );
  }

  return (
    <form onSubmit={join} className="space-y-4">
      {header}
      <Field label="Email"><Input value={inv.email} readOnly className="bg-slate-50 text-slate-600" /></Field>
      {!existing && <Field label="Your full name"><Input required autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Sandra Ebai" /></Field>}
      <Field label={existing ? "Your password" : "Choose a password"} hint={existing ? undefined : "At least 8 characters. Only you will know it."}>
        <PasswordInput required autoComplete={existing ? "current-password" : "new-password"} value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      {err && <Alert tone={existing && !password ? "info" : "danger"}>{err}</Alert>}
      <Button type="submit" block size="lg" loading={busy}>{existing ? "Sign in & join" : `Join ${inv.business_name}`}</Button>
      <p className="text-center text-xs text-slate-500">Next time, sign in with <b>{inv.email}</b> and this password.</p>
    </form>
  );
}

export default function InvitePage() {
  return (
    <AuthLayout title="Join your team">
      <Suspense><InviteInner /></Suspense>
    </AuthLayout>
  );
}
