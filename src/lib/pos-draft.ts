/** A sale in progress is saved continuously, so it survives switching tabs,
 *  reloading, the phone switching off, or signing in on another phone.
 *  Kept in this browser (instant, works offline) and on the server per user
 *  (to continue on another device). The newest copy wins. */
import { supabase } from "@/lib/supabase";

export interface DraftLine { key: string; product_id: string; qty: number; price: string; override?: unknown }
export interface DraftPay { key: string; method_id: string; amount: string; reference: string; label: string; proof?: string | null }
export interface Draft {
  v: 1; saved_at: string; tx_id: string; step: "browse" | "cart" | "pay";
  /** the sale was finished or cleared (on whichever device): nothing to restore */
  cleared?: boolean;
  lines: DraftLine[]; pays: DraftPay[]; customer: { name: string; phone: string; note: string };
}

const key = (biz: string, user: string) => `shopwise.pos.draft.${biz}.${user}`;

export function readLocalDraft(biz: string, user: string): Draft | null {
  try { const s = localStorage.getItem(key(biz, user)); return s ? (JSON.parse(s) as Draft) : null; } catch { return null; }
}

export async function readServerDraft(biz: string, user: string): Promise<Draft | null> {
  try {
    const { data, error } = await supabase().from("pos_drafts").select("data").eq("business_id", biz).eq("user_id", user).maybeSingle();
    if (error || !data) return null;
    return data.data as Draft;
  } catch { return null; }
}

/** the most recent of the two copies; null if that sale was already finished */
export async function loadDraft(biz: string, user: string, online: boolean): Promise<Draft | null> {
  const local = readLocalDraft(biz, user);
  const server = online ? await readServerDraft(biz, user) : null;
  let d = !local ? server : !server ? local : new Date(server.saved_at) > new Date(local.saved_at) ? server : local;
  if (d && !d.cleared && online) {
    // finished on another phone (or offline sale already synced)? then don't bring it back
    const { data } = await supabase().from("sales").select("id").eq("business_id", biz).eq("client_tx_id", d.tx_id).maybeSingle();
    if (data) d = null;
  }
  if (!d || d.cleared) { if (local) saveLocalDraft(biz, user, null); return null; }
  return d;
}

export function saveLocalDraft(biz: string, user: string, d: Draft | null) {
  try { if (d) localStorage.setItem(key(biz, user), JSON.stringify(d)); else localStorage.removeItem(key(biz, user)); } catch { /* storage full / private mode */ }
}

export async function saveServerDraft(biz: string, user: string, d: Draft | null) {
  try {
    const sb = supabase().from("pos_drafts");
    // a finished sale leaves a "cleared" marker, so older copies on other phones are ignored
    const data: Draft = d ?? { v: 1, saved_at: new Date().toISOString(), tx_id: "", step: "browse", lines: [], pays: [], customer: { name: "", phone: "", note: "" }, cleared: true };
    await sb.upsert({ business_id: biz, user_id: user, data, updated_at: data.saved_at });
  } catch { /* offline: the local copy is enough until next save */ }
}
