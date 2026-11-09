"use client";
import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { AuthLayout } from "@/components/auth-layout";
import { Alert, Button, Spinner } from "@/components/ui";
import { errorMessage, ROLE_LABEL } from "@/lib/format";

interface Inv { business_name: string; email: string; role: string; expired: boolean; accepted: boolean; revoked: boolean }

function InviteInner() {
  const router = useRouter();
  const token = useSearchParams().get("t") || "";
  const [inv, setInv] = useState<Inv | null | undefined>(undefined);
  const [me, setMe] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const sb = supabase();
    sb.rpc("get_invitation", { p_token: token }).then(({ data }) => setInv((data as Inv) || null));
    sb.auth.getSession().then(({ data }) => setMe(data.session?.user.email?.toLowerCase() || null));
  }, [token]);

  async function accept() {
    setBusy(true); setErr(null);
    const { data, error } = await supabase().rpc("accept_invitation", { p_token: token });
    setBusy(false);
    if (error) { setErr(errorMessage(error)); return; }
    try { localStorage.setItem("sw-biz", data as string); } catch {}
    router.replace("/app");
  }

  if (inv === undefined) return <Spinner />;
  if (!inv) return <Alert tone="danger" title="Invitation not found">Ask the shop owner to send you a new link.</Alert>;
  if (inv.revoked || inv.expired || inv.accepted) {
    return <Alert tone="warning" title={inv.accepted ? "Already used" : inv.expired ? "This invitation has expired" : "This invitation was cancelled"}>Ask the shop owner for a new invitation link.</Alert>;
  }

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-slate-200 p-4">
        <p className="text-sm text-slate-500">You&apos;ve been invited to join</p>
        <p className="text-xl font-bold">{inv.business_name}</p>
        <p className="mt-1 text-sm">as <b>{ROLE_LABEL[inv.role] || inv.role}</b> · {inv.email}</p>
      </div>
      {err && <Alert tone="danger">{err}</Alert>}
      {me ? (
        me === inv.email ? (
          <Button block size="lg" loading={busy} onClick={accept}>Join {inv.business_name}</Button>
        ) : (
          <Alert tone="warning" title={`You're signed in as ${me}`}>
            This invitation is for {inv.email}.{" "}
            <button className="font-semibold underline" onClick={() => supabase().auth.signOut().then(() => setMe(null))}>Sign out</button> and use the right account.
          </Alert>
        )
      ) : (
        <div className="space-y-2">
          <Link href={`/signup?invite=${token}&email=${encodeURIComponent(inv.email)}`}><Button block size="lg">Create my account</Button></Link>
          <Link href={`/login?next=${encodeURIComponent(`/invite?t=${token}`)}`}><Button block variant="secondary" size="lg" className="mt-2">I already have an account</Button></Link>
        </div>
      )}
    </div>
  );
}

export default function InvitePage() {
  return (
    <AuthLayout title="Join your team">
      <Suspense><InviteInner /></Suspense>
    </AuthLayout>
  );
}
