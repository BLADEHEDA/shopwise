import { DEFAULT_BRAND } from "./brand-defaults";
import type { Brand } from "./types";

/** Reads the public brand configuration on the server (manifest, metadata,
 *  icons). Cached for 5 minutes; falls back to defaults if unreachable. */
export async function getBrandServer(): Promise<Brand> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return DEFAULT_BRAND;
  try {
    const res = await fetch(`${url}/rest/v1/brand_config?id=eq.1&select=*`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      next: { revalidate: 300 },
    });
    if (!res.ok) return DEFAULT_BRAND;
    const rows = (await res.json()) as Brand[];
    return rows[0] ? { ...DEFAULT_BRAND, ...rows[0] } : DEFAULT_BRAND;
  } catch {
    return DEFAULT_BRAND;
  }
}
