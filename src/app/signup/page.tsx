"use client";
import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { AuthLayout } from "@/components/auth-layout";
import { Alert, Button, Field, Input } from "@/components/ui";
import { errorMessage } from "@/lib/format";

function SignupForm() {
  const router = useRouter();
  const params = useSearchParams();
  const invite = params.get("invite");
  const [name, setName] = useState("");
  const [email, setEmail] = useState(params.get("email") || "");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  const after = invite ? `/invite?t=${invite}` : "/onboarding";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 8) { setErr("Use at least 8 characters for your password."); return; }
    setBusy(true); setErr(null);
    const { data, error } = await supabase().auth.signUp({
      email: email.trim(), password,
      options: { data: { full_name: name.trim() }, emailRedirectTo: `${window.location.origin}${after}` },
    });
    setBusy(false);
    if (error) { setErr(errorMessage(error)); return; }
    if (data.session) router.replace(after);
    else setSent(true);
  }

  if (sent) {
    return (
      <Alert tone="success" title="Check your email">
        We sent a confirmation link to <b>{email}</b>. Open it on this phone to continue.
      </Alert>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {err && <Alert tone="danger">{err}</Alert>}
      <Field label="Your full name"><Input required autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="Email"><Input type="email" required autoComplete="email" value={email} readOnly={!!invite && !!params.get("email")} onChange={(e) => setEmail(e.target.value)} /></Field>
      <Field label="Password" hint="At least 8 characters"><Input type="password" required autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
      <Button type="submit" block size="lg" loading={busy}>{invite ? "Create account & join" : "Create account"}</Button>
      <p className="text-center text-sm text-slate-600">Already have an account? <Link href={invite ? `/login?next=${encodeURIComponent(after)}` : "/login"} className="font-medium text-brand hover:underline">Sign in</Link></p>
    </form>
  );
}

export default function SignupPage() {
  return (
    <AuthLayout title="Create your account" subtitle="Owners create the business. Staff join by invitation.">
      <Suspense><SignupForm /></Suspense>
    </AuthLayout>
  );
}
