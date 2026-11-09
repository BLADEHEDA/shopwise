"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ChevronLeft, Copy, MessageCircle, UserPlus } from "lucide-react";
import { useBiz } from "@/components/biz";
import { useToast } from "@/components/toast";
import { Alert, Badge, Button, Card, Field, Input, PageHeader, Select, Sheet, Spinner } from "@/components/ui";
import { supabase } from "@/lib/supabase";
import { errorMessage, fmtDate, ROLE_LABEL } from "@/lib/format";
import type { Membership, Role } from "@/lib/types";

interface Member extends Membership { profiles?: { full_name: string | null; email: string | null; phone: string | null } | null }
interface Invite { id: string; email: string; role: Role; token: string; expires_at: string; accepted_at: string | null; revoked_at: string | null }

const ROLE_HELP: Record<Role, string> = {
  owner: "Everything: all sections, costs, reports, team and settings.",
  section_owner: "Partner: costs, profit, stock and approvals for their own sections only.",
  manager: "Runs operations: products, stock, staff. Financial access is optional.",
  staff: "Sells at the POS and sees only their own sales. Never sees cost prices.",
  accountant: "Read-only reports for the sections you choose.",
};

export default function TeamPage() {
  const biz = useBiz();
  const { business, sections, userId } = biz;
  const toast = useToast();
  const [members, setMembers] = useState<Member[] | null>(null);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [editing, setEditing] = useState<Member | "new" | null>(null);
  const [link, setLink] = useState<string | null>(null);

  const load = useCallback(async () => {
    const sb = supabase();
    const [m, ms, i] = await Promise.all([
      sb.from("memberships").select("*, profiles(full_name, email, phone)").eq("business_id", business.id).order("created_at"),
      sb.from("membership_sections").select("membership_id, section_id").eq("business_id", business.id),
      sb.from("invitations").select("*").eq("business_id", business.id).is("accepted_at", null).is("revoked_at", null).order("created_at", { ascending: false }),
    ]);
    const list = (m.data || []) as Member[];
    for (const x of list) x.section_ids = ((ms.data || []) as { membership_id: string; section_id: string }[]).filter((r) => r.membership_id === x.id).map((r) => r.section_id);
    setMembers(list); setInvites((i.data || []) as Invite[]);
  }, [business.id]);
  useEffect(() => { load(); }, [load]);

  if (!biz.isOwner) return <Alert tone="warning">Only the business owner can manage the team.</Alert>;
  const inviteUrl = (t: string) => `${typeof window !== "undefined" ? window.location.origin : ""}/invite?t=${t}`;
  const scope = (m: { all_sections: boolean; section_ids?: string[]; role: Role }) =>
    m.role === "owner" || m.all_sections ? "All sections" : (m.section_ids || []).map((id) => sections.find((s) => s.id === id)?.name).filter(Boolean).join(", ") || "No sections";

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <Link href="/app/settings" className="inline-flex items-center gap-1 text-sm font-medium text-slate-600"><ChevronLeft className="size-4" /> Settings</Link>
      <PageHeader title="Team & permissions" subtitle="People only join through your invitation." actions={<Button onClick={() => setEditing("new")}><UserPlus className="size-4" /> Invite someone</Button>} />

      {link && (
        <Alert tone="success" title="Invitation created">
          <p>Send this link to the person. It works once, for their email only, for 7 days.</p>
          <p className="mt-2 break-all rounded-lg bg-white p-2 font-mono text-xs">{link}</p>
          <div className="mt-2 flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => { navigator.clipboard.writeText(link); toast("Link copied"); }}><Copy className="size-4" /> Copy</Button>
            <Button size="sm" variant="secondary" onClick={() => window.open(`https://wa.me/?text=${encodeURIComponent(`You've been invited to join ${business.name}. Open this link to set up your account: ${link}`)}`, "_blank")}><MessageCircle className="size-4" /> WhatsApp</Button>
          </div>
        </Alert>
      )}

      {members === null ? <Spinner /> : (
        <Card>
          <ul className="divide-y divide-slate-100">
            {members.map((m) => (
              <li key={m.id} className="flex items-center gap-3 px-4 py-3">
                <div className="grid size-10 place-items-center rounded-full bg-brand-100 font-semibold text-brand-700">{(m.profiles?.full_name || m.profiles?.email || "?").charAt(0).toUpperCase()}</div>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{m.profiles?.full_name || m.profiles?.email} {m.user_id === userId && <span className="text-xs text-slate-500">(you)</span>} {!m.active && <Badge tone="danger">Disabled</Badge>}</p>
                  <p className="truncate text-xs text-slate-500">{ROLE_LABEL[m.role]} · {scope(m)}{m.can_view_costs && m.role !== "owner" ? " · sees costs" : ""}</p>
                </div>
                <Button size="sm" variant="secondary" onClick={() => setEditing(m)}>Edit</Button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {invites.length > 0 && (
        <Card>
          <h2 className="border-b border-slate-100 px-4 py-3 font-semibold">Pending invitations</h2>
          <ul className="divide-y divide-slate-100">
            {invites.map((i) => {
              const expired = new Date(i.expires_at) < new Date();
              return (
                <li key={i.id} className="flex flex-wrap items-center gap-2 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{i.email}</p>
                    <p className="text-xs text-slate-500">{ROLE_LABEL[i.role]} · {expired ? "expired" : `expires ${fmtDate(i.expires_at)}`}</p>
                  </div>
                  {!expired && <Button size="sm" variant="ghost" onClick={() => { navigator.clipboard.writeText(inviteUrl(i.token)); toast("Link copied"); }}><Copy className="size-4" /></Button>}
                  <Button size="sm" variant="ghost" onClick={async () => { const { error } = await supabase().rpc("revoke_invitation", { p_id: i.id }); if (error) toast(errorMessage(error), "error"); else load(); }}>Cancel</Button>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      <Card className="p-4 text-sm">
        <h2 className="mb-2 font-semibold">What each role can do</h2>
        <dl className="space-y-1.5">{(Object.keys(ROLE_HELP) as Role[]).map((r) => <div key={r}><dt className="inline font-medium">{ROLE_LABEL[r]}: </dt><dd className="inline text-slate-600">{ROLE_HELP[r]}</dd></div>)}</dl>
        <p className="mt-3 text-xs text-slate-500">Lost phone or someone leaving? Edit the person and turn off <b>Access enabled</b>. They lose access immediately and any open shift is closed.</p>
      </Card>

      {editing && <MemberSheet member={editing === "new" ? null : editing} onClose={() => setEditing(null)}
        onInvited={(t) => { setEditing(null); setLink(inviteUrl(t)); load(); }} onSaved={() => { setEditing(null); load(); toast("Permissions updated"); }} />}
    </div>
  );
}

function MemberSheet({ member, onClose, onInvited, onSaved }: { member: Member | null; onClose: () => void; onInvited: (token: string) => void; onSaved: () => void }) {
  const { business, sections } = useBiz();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>(member?.role || "staff");
  const [all, setAll] = useState(member?.all_sections ?? false);
  const [secs, setSecs] = useState<string[]>(member?.section_ids || []);
  const [costs, setCosts] = useState(member?.can_view_costs ?? false);
  const [active, setActive] = useState(member?.active ?? true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isOwnerRole = role === "owner";

  async function save() {
    setErr(null);
    if (!isOwnerRole && !all && secs.length === 0) return setErr("Choose at least one section, or All sections.");
    setBusy(true);
    if (!member) {
      const { data, error } = await supabase().rpc("create_invitation", { p_business: business.id, p_email: email, p_role: role, p_all_sections: all, p_section_ids: secs, p_can_view_costs: costs });
      setBusy(false);
      if (error) setErr(errorMessage(error)); else onInvited(data as string);
    } else {
      const { error } = await supabase().rpc("update_member", { p_membership: member.id, p_role: role, p_all_sections: all, p_section_ids: secs, p_can_view_costs: costs, p_active: active });
      setBusy(false);
      if (error) setErr(errorMessage(error)); else onSaved();
    }
  }

  return (
    <Sheet open onClose={onClose} title={member ? `Edit ${member.profiles?.full_name || member.profiles?.email}` : "Invite someone"}
      footer={<Button block size="lg" loading={busy} onClick={save}>{member ? "Save permissions" : "Create invitation link"}</Button>}>
      <div className="space-y-4">
        {!member && <Field label="Their email" hint="They must sign up with this exact email"><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>}
        <Field label="Role" hint={ROLE_HELP[role]}>
          <Select value={role} onChange={(e) => { const r = e.target.value as Role; setRole(r); if (r === "staff") setCosts(false); if (r === "section_owner") setCosts(true); }}>
            {(["staff", "manager", "section_owner", "accountant", "owner"] as Role[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
          </Select>
        </Field>
        {!isOwnerRole && (
          <div>
            <p className="mb-1.5 text-sm font-medium text-slate-700">Sections</p>
            <label className="mb-2 flex items-center gap-2 text-sm"><input type="checkbox" className="size-4 accent-brand" checked={all} onChange={(e) => setAll(e.target.checked)} /> All sections (including future ones)</label>
            {!all && (
              <div className="space-y-1.5 rounded-xl border border-slate-200 p-3">
                {sections.map((s) => (
                  <label key={s.id} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" className="size-4 accent-brand" checked={secs.includes(s.id)} onChange={(e) => setSecs(e.target.checked ? [...secs, s.id] : secs.filter((x) => x !== s.id))} /> {s.name}
                  </label>
                ))}
              </div>
            )}
          </div>
        )}
        {(role === "manager" || role === "section_owner" || role === "accountant") && (
          <label className="flex items-start gap-2 rounded-xl border border-slate-200 p-3 text-sm">
            <input type="checkbox" className="mt-0.5 size-4 accent-brand" checked={costs} onChange={(e) => setCosts(e.target.checked)} />
            <span><b>Financial access</b>: cost prices, margins, suppliers and profit for the sections above.{role === "section_owner" && " Turn on so the partner sees their own section's profit."}</span>
          </label>
        )}
        {role === "staff" && <Alert tone="info">Sales staff can never see cost prices, suppliers or owner reports.</Alert>}
        {member && (
          <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" className="size-4 accent-brand" checked={active} onChange={(e) => setActive(e.target.checked)} /> Access enabled</label>
        )}
        {err && <Alert tone="danger">{err}</Alert>}
      </div>
    </Sheet>
  );
}
