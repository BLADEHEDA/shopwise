"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import type { Business, Membership, Profile, Role, Section, Shift } from "@/lib/types";

interface BizCtx {
  session: Session;
  userId: string;
  profile: Profile | null;
  memberships: Membership[];
  membership: Membership;
  business: Business;
  sections: Section[];
  role: Role;
  isOwner: boolean;
  isPlatformAdmin: boolean;
  shift: Shift | null;
  online: boolean;
  hasSection: (s: string | null) => boolean;
  canViewCosts: (s?: string | null) => boolean;
  canManage: (s?: string | null) => boolean;
  canApprove: (s?: string | null) => boolean;
  canReport: boolean;
  canManageAny: boolean;
  canApproveAny: boolean;
  costsAnywhere: boolean;
  mySections: Section[];
  setBusiness: (id: string) => void;
  refresh: () => Promise<void>;
  refreshShift: () => Promise<void>;
}

const Ctx = createContext<BizCtx | null>(null);
export function useBiz(): BizCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useBiz outside provider");
  return c;
}

interface Snapshot { profile: Profile | null; memberships: Membership[]; sections: Section[]; isPlatformAdmin: boolean; shift: Shift | null }

export function BizProvider({ children, fallback }: { children: React.ReactNode; fallback: React.ReactNode }) {
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [bizId, setBizId] = useState<string | null>(null);
  const [online, setOnline] = useState(true);

  const load = useCallback(async (s: Session) => {
    const sb = supabase();
    const uid = s.user.id;
    try {
      const [prof, mem, admin] = await Promise.all([
        sb.from("profiles").select("*").eq("user_id", uid).maybeSingle(),
        sb.from("memberships").select("*, businesses(*)").eq("user_id", uid).eq("active", true),
        sb.from("platform_admins").select("user_id").eq("user_id", uid).maybeSingle(),
      ]);
      if (mem.error) throw mem.error;
      const memberships = (mem.data || []) as Membership[];
      const ids = memberships.map((m) => m.business_id);
      const [secs, ms] = await Promise.all([
        ids.length ? sb.from("sections").select("*").in("business_id", ids).order("name") : Promise.resolve({ data: [] as Section[] }),
        ids.length ? sb.from("membership_sections").select("membership_id, section_id").in("membership_id", memberships.map((m) => m.id)) : Promise.resolve({ data: [] as { membership_id: string; section_id: string }[] }),
      ]);
      for (const m of memberships) {
        m.section_ids = ((ms.data || []) as { membership_id: string; section_id: string }[]).filter((x) => x.membership_id === m.id).map((x) => x.section_id);
      }
      const shiftRes = ids.length
        ? await sb.from("shifts").select("*").eq("user_id", uid).is("ended_at", null).order("started_at", { ascending: false })
        : { data: [] };
      const next: Snapshot = {
        profile: (prof.data as Profile) || null,
        memberships,
        sections: (secs.data || []) as Section[],
        isPlatformAdmin: Boolean(admin.data),
        shift: null,
      };
      // shift for the active business is resolved below
      (next as Snapshot & { shifts?: Shift[] }).shifts = (shiftRes.data || []) as Shift[];
      setSnap(next);
      try { localStorage.setItem(`sw-snap:${uid}`, JSON.stringify(next)); } catch {}
      if (!memberships.length) router.replace("/onboarding");
    } catch {
      // offline: fall back to the last known context
      try {
        const raw = localStorage.getItem(`sw-snap:${uid}`);
        if (raw) setSnap(JSON.parse(raw));
      } catch {}
    }
  }, [router]);

  useEffect(() => {
    const sb = supabase();
    sb.auth.getSession().then(({ data }) => {
      if (!data.session) { router.replace("/login"); return; }
      setSession(data.session);
      load(data.session);
    });
    const { data: sub } = sb.auth.onAuthStateChange((evt, s) => {
      if (evt === "SIGNED_OUT") router.replace("/login");
      if (s) setSession(s);
    });
    return () => sub.subscription.unsubscribe();
  }, [load, router]);

  useEffect(() => {
    try { setBizId(localStorage.getItem("sw-biz")); } catch {}
    const up = () => setOnline(navigator.onLine);
    up();
    window.addEventListener("online", up);
    window.addEventListener("offline", up);
    return () => { window.removeEventListener("online", up); window.removeEventListener("offline", up); };
  }, []);

  const value = useMemo<BizCtx | null>(() => {
    if (!session || !snap || !snap.memberships.length) return null;
    const membership = snap.memberships.find((m) => m.business_id === bizId) || snap.memberships[0];
    const business = membership.businesses as Business;
    const sections = snap.sections.filter((s) => s.business_id === membership.business_id);
    const role = membership.role;
    const isOwner = role === "owner";
    const hasSection = (s: string | null) => isOwner || membership.all_sections || (!!s && (membership.section_ids || []).includes(s));
    const canViewCosts = (s?: string | null) => isOwner || (["section_owner", "manager", "accountant"].includes(role) && membership.can_view_costs && (s === undefined ? true : hasSection(s ?? null)));
    const canManage = (s?: string | null) => isOwner || (["section_owner", "manager"].includes(role) && (s === undefined ? true : hasSection(s ?? null)));
    const canApprove = (s?: string | null) => isOwner || (role === "section_owner" && (s === undefined ? true : hasSection(s ?? null)));
    const shifts = ((snap as Snapshot & { shifts?: Shift[] }).shifts || []);
    const shift = snap.shift ?? shifts.find((x) => x.business_id === membership.business_id) ?? null;
    return {
      session, userId: session.user.id, profile: snap.profile, memberships: snap.memberships, membership, business,
      sections, role, isOwner, isPlatformAdmin: snap.isPlatformAdmin, shift, online,
      hasSection, canViewCosts, canManage, canApprove,
      canReport: role !== "staff",
      canManageAny: isOwner || ["section_owner", "manager"].includes(role),
      canApproveAny: isOwner || role === "section_owner" || (role === "manager" && membership.can_view_costs),
      costsAnywhere: canViewCosts(),
      mySections: sections.filter((s) => s.active && hasSection(s.id)),
      setBusiness: (id: string) => { try { localStorage.setItem("sw-biz", id); } catch {}; setBizId(id); },
      refresh: async () => { await load(session); },
      refreshShift: async () => {
        const { data } = await supabase().from("shifts").select("*").eq("user_id", session.user.id).eq("business_id", membership.business_id).is("ended_at", null).maybeSingle();
        setSnap((p) => {
          if (!p) return p;
          const others = ((p as Snapshot & { shifts?: Shift[] }).shifts || []).filter((x) => x.business_id !== membership.business_id);
          const n = { ...p, shift: null, shifts: data ? [...others, data as Shift] : others } as Snapshot;
          try { localStorage.setItem(`sw-snap:${session.user.id}`, JSON.stringify(n)); } catch {}
          return n;
        });
      },
    };
  }, [session, snap, bizId, online, load]);

  if (!value) return <>{fallback}</>;
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
