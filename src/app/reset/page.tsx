"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { AuthLayout } from "@/components/auth-layout";
import { Alert, Button, Field, PasswordInput } from "@/components/ui";
import { errorMessage } from "@/lib/format";

export default function ResetPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const sb = supabase();
    sb.auth.getSession().then(({ data }) => { if (data.session) setReady(true); });
    const { data } = sb.auth.onAuthStateChange((evt, s) => { if (evt === "PASSWORD_RECOVERY" || s) setReady(true); });
    return () => data.subscription.unsubscribe();
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 8) { setErr("Use at least 8 characters."); return; }
    setBusy(true); setErr(null);
    const { error } = await supabase().auth.updateUser({ password });
    setBusy(false);
    if (error) setErr(errorMessage(error)); else router.replace("/app");
  }

  return (
    <AuthLayout title="Choose a new password">
      {!ready ? <Alert tone="info">Open this page from the link in your reset email.</Alert> : (
        <form onSubmit={submit} className="space-y-4">
          {err && <Alert tone="danger">{err}</Alert>}
          <Field label="New password"><PasswordInput autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
          <Button type="submit" block size="lg" loading={busy}>Save password</Button>
        </form>
      )}
    </AuthLayout>
  );
}
