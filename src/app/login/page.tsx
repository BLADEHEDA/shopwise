"use client";
import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { AuthLayout } from "@/components/auth-layout";
import { DemoLogin } from "@/components/demo-login";
import { Alert, Button, Field, Input, PasswordInput } from "@/components/ui";
import { errorMessage } from "@/lib/format";

function LoginForm() {
  const router = useRouter();
  const next = useSearchParams().get("next") || "/app";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    const { error } = await supabase().auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (error) { setErr(error.message === "Invalid login credentials" ? "Wrong email or password." : errorMessage(error)); return; }
    router.replace(next.startsWith("/") ? next : "/app");
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {err && <Alert tone="danger">{err}</Alert>}
      <Field label="Email"><Input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
      <Field label="Password"><PasswordInput autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
      <Button type="submit" block size="lg" loading={busy}>Sign in</Button>
      <div className="flex justify-between text-sm">
        <Link href="/forgot" className="font-medium text-brand hover:underline">Forgot password?</Link>
        <Link href="/signup" className="font-medium text-brand hover:underline">Create a business</Link>
      </div>
      <p className="pt-2 text-xs text-slate-500">Joining a shop? Open the invitation link you received. You can&apos;t join a business without one.</p>
    </form>
  );
}

export default function LoginPage() {
  return (
    <AuthLayout title="Welcome back" subtitle="Sign in to your shop">
      <Suspense><LoginForm /></Suspense>
      <DemoLogin />
    </AuthLayout>
  );
}
