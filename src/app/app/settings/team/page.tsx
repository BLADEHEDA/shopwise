"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Check, ChevronLeft, Copy, MessageCircle, Trash2, UserPlus } from "lucide-react";
import { useDialog } from "@/components/dialog";
import { useBiz } from "@/components/biz";
import { useToast } from "@/components/toast";
import { Alert, Badge, Button, Card, Field, Input, PageHeader, Sheet, Spinner } from "@/components/ui";
import { supabase } from "@/lib/supabase";
import { cx, errorMessage, fmtDate, ROLE_LABEL } from "@/lib/format";
import type { Membership, Role } from "@/lib/types";

interface Member extends Membership { profiles?: { full_name: string | null; email: string | null; phone: string | null } | null }
interface Invite { id: string; email: string; role: Role; token: string; expires_at: string; accepted_at: string | null; revoked_at: string | null }

/** wa.me needs the full international number without + or spaces.
 *  Cameroon numbers are 9 digits starting with 6/2; add 237 for those. */
function waNumber(phone: string): string {
  const d = phone.replace(/\D/g, "");
  if (!d) return "";
  return d.length === 9 && /^[62]/.test(d) ? `237${d}` : d;
}

const ROLE_HELP: Record<Role, string> = {
  owner: "The person who created the business. Sees and controls everything, and can never be removed. There is only one per business. For a co-owner, use Shop owner with all sections, financial access and \"Can manage the team\".",
  section_owner: "Owns one or more sections (e.g. a partner's business inside the shop). Sees stock, cost prices, profit and approvals for their own sections only.",
  manager: "Runs day-to-day operations (products, stock, staff) for the sections you choose. Seeing costs and profit is optional.",
  staff: "Sells at the POS in the sections you tick (e.g. section A and B, or only B). Sees only their own sales and never sees cost prices.",
  accountant: "Can view reports for the sections you choose, but can't change anything.",
};

export default function TeamPage() {
  const biz = useBiz();
  const { business, sections, userId } = biz;
  const toast = useToast();
  const [members, setMembers] = useState<Member[] | null>(null);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [editing, setEditing] = useState<Member | "new" | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [linkPhone, setLinkPhone] = useState("");

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

  if (!biz.canManageTeam) return <Alert tone="warning">Only the super admin, or a shop owner they allowed to manage the team, can open this page.</Alert>;
  const inviteUrl = (t: string) => `${typeof window !== "undefined" ? window.location.origin : ""}/invite?t=${t}`;
  const scope = (m: { all_sections: boolean; section_ids?: string[]; role: Role }) =>
    m.role === "owner" || m.all_sections ? "All sections" : (m.section_ids || []).map((id) => sections.find((s) => s.id === id)?.name).filter(Boolean).join(", ") || "No sections";

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <Link href="/app/settings" className="inline-flex items-center gap-1 text-sm font-medium text-slate-600"><ChevronLeft className="size-4" /> Settings</Link>
      <PageHeader title="Team & permissions" subtitle="People only join through your invitation." actions={<Button onClick={() => setEditing("new")}><UserPlus className="size-4" /> Invite someone</Button>} />

      {link && (
        <Alert tone="success" title="Invitation created">
          <p>Send this link to the person (WhatsApp is easiest). They open it, type their name and choose their own password, and they&apos;re in with exactly the access you set. The link works once, only for that email, for 7 days.</p>
          <p className="mt-2 break-all rounded-lg bg-white p-2 font-mono text-xs">{link}</p>
          <div className="mt-2 flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => { navigator.clipboard.writeText(link); toast("Link copied"); }}><Copy className="size-4" /> Copy</Button>
            <Button size="sm" variant="secondary" onClick={() => window.open(`https://wa.me/${waNumber(linkPhone)}?text=${encodeURIComponent(`You've been invited to join ${business.name}. Open this link, type your name and choose your password: ${link}`)}`, "_blank")}><MessageCircle className="size-4" /> {linkPhone ? `Send on WhatsApp to ${linkPhone}` : "WhatsApp"}</Button>
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
                  <p className="truncate text-xs text-slate-500">{ROLE_LABEL[m.role]} · {scope(m)}{m.can_view_costs && m.role !== "owner" ? (m.cost_section_ids ? ` · costs: ${m.cost_section_ids.map((id) => sections.find((x) => x.id === id)?.name).filter(Boolean).join(", ")}` : " · sees costs") : ""}{m.can_manage_team && m.role !== "owner" ? " · manages team" : ""}</p>
                </div>
                {m.role === "owner" ? <Badge tone="brand">Created the business</Badge>
                  : m.user_id === userId && !biz.isOwner ? null
                  : <Button size="sm" variant="secondary" onClick={() => setEditing(m)}>Edit</Button>}
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
        <p className="mt-3 text-xs text-slate-500">Lost phone or someone leaving? Edit the person and turn off <b>Access enabled</b>, or <b>Remove</b> them. They lose access immediately and any open shift is closed; their past sales stay in the history.</p>
      </Card>

      {editing && <MemberSheet member={editing === "new" ? null : editing} onClose={() => setEditing(null)}
        onInvited={(t, ph) => { setEditing(null); setLink(inviteUrl(t)); setLinkPhone(ph); load(); }} onSaved={() => { setEditing(null); load(); toast("Permissions updated"); }}
        onRemoved={() => { setEditing(null); load(); toast("Removed from the shop"); }} />}
    </div>
  );
}

const ROLE_SHORT: Record<Role, string> = {
  staff: "Sells at the POS. Never sees cost prices.",
  section_owner: "Owns sections of the shop: their stock, sales and (if you allow) profit.",
  manager: "Runs products, stock and staff for the sections you pick.",
  accountant: "Views reports only. Can't change anything.",
  owner: "The person who created the business. Only one per business.",
};

function Toggle({ checked, onChange, label, sub }: { checked: boolean; onChange: (v: boolean) => void; label: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-3 rounded-xl border border-slate-200 bg-white p-3">
      <span className="text-sm"><span className="font-medium text-ink">{label}</span>{sub && <span className="mt-0.5 block text-xs text-slate-500">{sub}</span>}</span>
      <span className="relative mt-0.5 inline-flex shrink-0">
        <input type="checkbox" role="switch" className="peer sr-only" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span className="h-6 w-11 rounded-full bg-slate-300 transition peer-checked:bg-brand peer-focus-visible:ring-2 peer-focus-visible:ring-brand/30" />
        <span className="absolute left-0.5 top-0.5 size-5 rounded-full bg-white shadow transition peer-checked:translate-x-5" />
      </span>
    </label>
  );
}

function Chips({ items, value, onChange, label }: { items: { id: string; name: string }[]; value: string[]; onChange: (v: string[]) => void; label: string }) {
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label={label}>
      {items.map((s) => {
        const on = value.includes(s.id);
        return (
          <button key={s.id} type="button" aria-pressed={on} onClick={() => onChange(on ? value.filter((x) => x !== s.id) : [...value, s.id])}
            className={cx("inline-flex h-9 items-center gap-1.5 rounded-full border px-3 text-sm font-medium transition",
              on ? "border-brand bg-brand-50 text-brand-800" : "border-slate-300 bg-white text-slate-700 hover:border-brand")}>
            {on && <Check className="size-3.5" />}{s.name}
          </button>
        );
      })}
    </div>
  );
}

function MemberSheet({ member, onClose, onInvited, onSaved, onRemoved }: { member: Member | null; onClose: () => void; onInvited: (token: string, phone: string) => void; onSaved: () => void; onRemoved: () => void }) {
  const { business, sections, userId, isOwner } = useBiz();
  const dialog = useDialog();
  const [team, setTeam] = useState(member?.can_manage_team ?? false);
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [role, setRole] = useState<Role>(member?.role || "staff");
  const [all, setAll] = useState(member?.all_sections ?? false);
  const [secs, setSecs] = useState<string[]>(member?.section_ids || []);
  const [costs, setCosts] = useState(member?.can_view_costs ?? false);
  const [costSecs, setCostSecs] = useState<string[] | null>(member?.cost_section_ids ?? null);
  const [active, setActive] = useState(member?.active ?? true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isOwnerRole = role === "owner";
  const financialRole = role === "manager" || role === "section_owner" || role === "accountant";
  const teamRole = role === "manager" || role === "section_owner";
  const theirSections = all ? sections : sections.filter((s) => secs.includes(s.id));
  const name = member?.profiles?.full_name || member?.profiles?.email || "";
  const self = member?.user_id === userId;

  async function save() {
    setErr(null);
    if (!member && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) return setErr("Enter their email address.");
    if (!isOwnerRole && !all && secs.length === 0) return setErr("Choose at least one section, or All sections.");
    const viewCosts = financialRole && costs;
    // limit to sections they actually have; null = all their sections
    const limit = viewCosts && costSecs !== null ? costSecs.filter((id) => theirSections.some((s) => s.id === id)) : null;
    if (viewCosts && limit !== null && limit.length === 0) return setErr("Pick at least one section for financial access, or turn it off.");
    setBusy(true);
    const sb = supabase();
    if (!member) {
      const { data, error } = await sb.rpc("create_invitation", { p_business: business.id, p_email: email, p_role: role, p_all_sections: all, p_section_ids: secs, p_can_view_costs: viewCosts, p_phone: phone.trim() || null });
      if (!error && limit !== null) {
        const r = await sb.rpc("set_invitation_cost_sections", { p_token: data, p_section_ids: limit });
        if (r.error) { setBusy(false); return setErr(errorMessage(r.error)); }
      }
      if (!error && isOwner && teamRole && team) {
        const r = await sb.rpc("set_invitation_team_access", { p_token: data, p_allowed: true });
        if (r.error) { setBusy(false); return setErr(errorMessage(r.error)); }
      }
      setBusy(false);
      if (error) setErr(errorMessage(error)); else onInvited(data as string, phone.trim());
    } else {
      const { error } = await sb.rpc("update_member", { p_membership: member.id, p_role: role, p_all_sections: all, p_section_ids: secs, p_can_view_costs: viewCosts, p_active: active });
      if (!error && !isOwnerRole) {
        const r = await sb.rpc("set_member_cost_sections", { p_membership: member.id, p_section_ids: limit });
        if (r.error) { setBusy(false); return setErr(errorMessage(r.error)); }
      }
      if (!error && isOwner && !isOwnerRole && (member.can_manage_team ?? false) !== (teamRole && team)) {
        const r = await sb.rpc("set_team_access", { p_membership: member.id, p_allowed: teamRole && team });
        if (r.error) { setBusy(false); return setErr(errorMessage(r.error)); }
      }
      setBusy(false);
      if (error) setErr(errorMessage(error)); else onSaved();
    }
  }

  async function remove() {
    if (!member) return;
    const ok = await dialog.confirm({ title: `Remove ${name}?`, tone: "danger", confirmLabel: "Remove",
      message: <>They lose access to <b>{business.name}</b> immediately and any open shift is closed. Their past sales and records stay in the history. You can invite them again later.</> });
    if (!ok) return;
    setBusy(true);
    const { error } = await supabase().rpc("remove_member", { p_membership: member.id });
    setBusy(false);
    if (error) setErr(errorMessage(error)); else onRemoved();
  }

  return (
    <Sheet open onClose={onClose} title={member ? `Edit ${name}` : "Invite someone"} wide
      footer={
        <div className="grid grid-cols-[auto_1fr] gap-2">
          <Button variant="secondary" size="lg" onClick={onClose}>Cancel</Button>
          <Button block size="lg" loading={busy} onClick={save}>{member ? "Save changes" : "Create invitation link"}</Button>
        </div>
      }>
      <div className="space-y-5">
        {!member && (
          <section className="grid gap-3 sm:grid-cols-2">
            <Field label="Their email" hint="They sign in with this email"><Input type="email" placeholder="name@example.com" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
            <Field label="WhatsApp number (optional)" hint="To send them the link directly"><Input inputMode="tel" placeholder="6XX XXX XXX" value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
          </section>
        )}

        {!isOwnerRole && <section>
          <h3 className="mb-2 text-sm font-semibold text-slate-700">Role</h3>
          <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Role">
            {(["staff", "section_owner", "manager", "accountant"] as Role[]).map((r) => (
              <button key={r} type="button" role="radio" aria-checked={role === r} disabled={self && r !== "owner"}
                onClick={() => { setRole(r); if (r === "staff") setCosts(false); if (r === "section_owner") setCosts(true); if (r !== "section_owner" && r !== "manager") setTeam(false); }}
                className={cx("flex items-start gap-2.5 rounded-xl border p-3 text-left outline-none transition focus-visible:ring-2 focus-visible:ring-brand/40 disabled:opacity-40",
                  role === r ? "border-brand bg-brand-50 ring-1 ring-brand" : "border-slate-200 bg-white hover:border-brand/50")}>
                <span className={cx("mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border-2", role === r ? "border-brand" : "border-slate-300")}>
                  {role === r && <span className="size-2 rounded-full bg-brand" />}
                </span>
                <span><span className="block text-sm font-semibold text-ink">{ROLE_LABEL[r]}</span><span className="block text-xs text-slate-500">{ROLE_SHORT[r]}</span></span>
              </button>
            ))}
          </div>
        </section>}

        {!isOwnerRole && (
          <section className="space-y-2">
            <h3 className="text-sm font-semibold text-slate-700">Sections they work in</h3>
            <Toggle checked={all} onChange={setAll} label="All sections" sub="Including sections you add later" />
            {!all && <Chips items={sections} value={secs} onChange={setSecs} label="Sections" />}
          </section>
        )}

        {financialRole && (
          <section className="space-y-2">
            <h3 className="text-sm font-semibold text-slate-700">Financial access</h3>
            <Toggle checked={costs} onChange={setCosts} label="Can see cost prices, margins and profit" sub="Turn off to hide all money-in-stock figures from them" />
            {costs && theirSections.length > 1 && (
              <div className="space-y-2 rounded-xl bg-slate-50 p-3">
                <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Financial access for">
                  {[{ v: true, l: "All their sections" }, { v: false, l: "Only some sections" }].map((o) => (
                    <button key={o.l} type="button" role="radio" aria-checked={(costSecs === null) === o.v}
                      onClick={() => setCostSecs(o.v ? null : (costSecs ?? theirSections.map((s) => s.id)))}
                      className={cx("h-9 rounded-full border px-3 text-sm font-medium", (costSecs === null) === o.v ? "border-brand bg-brand text-white" : "border-slate-300 bg-white text-slate-700")}>
                      {o.l}
                    </button>
                  ))}
                </div>
                {costSecs !== null && (
                  <>
                    <p className="text-xs text-slate-500">They see costs and profit only for the sections ticked here. For the others they see stock and selling prices only.</p>
                    <Chips items={theirSections} value={costSecs} onChange={setCostSecs} label="Sections with financial access" />
                  </>
                )}
              </div>
            )}
          </section>
        )}
        {role === "staff" && <Alert tone="info">Shopkeepers never see cost prices, suppliers or profit.</Alert>}
        {isOwnerRole && <Alert tone="info" title="Super admin">The person who created the business. Sees and controls everything and can never be removed. To hand the business over, change this account&apos;s login email and password in Settings → Login &amp; security.</Alert>}
        {teamRole && isOwner && (
          <section className="space-y-2">
            <h3 className="text-sm font-semibold text-slate-700">Team management</h3>
            <Toggle checked={team} onChange={setTeam} label="Can manage the team" sub="Invite, edit and remove shopkeepers and other shop owners. They can never change or remove you (the super admin), and can't change their own access." />
          </section>
        )}

        {member && (
          <section className="space-y-2">
            <h3 className="text-sm font-semibold text-slate-700">Access</h3>
            {!self && <Toggle checked={active} onChange={setActive} label="Access enabled" sub="Turn off for a lost phone or a short break. They can't sign in until you turn it back on." />}
            {!self && member.role !== "owner" && (
              <button type="button" onClick={remove} className="flex w-full items-center gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-left text-sm font-semibold text-red-700 hover:bg-red-100">
                <Trash2 className="size-4" /> Remove {name} from the shop
              </button>
            )}
            {self && <p className="text-xs text-slate-500">This is your own account. Change your email or password in Settings → Login &amp; security.</p>}
          </section>
        )}
        {err && <Alert tone="danger">{err}</Alert>}
      </div>
    </Sheet>
  );
}
