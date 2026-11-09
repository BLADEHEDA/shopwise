import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || "http://localhost:8000";
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "missing-anon-key";

let client: SupabaseClient | null = null;

/** Fail fast when the device is offline (the client otherwise retries GETs
 *  with backoff, which makes the app look frozen), and never wait forever on
 *  a bad connection. Retrying a sale after a timeout is safe: every sale
 *  carries an idempotency key. */
const smartFetch: typeof fetch = (input, init) => {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    const err = new Error("Failed to fetch (offline)");
    err.name = "AbortError";
    return Promise.reject(err);
  }
  const timeout = AbortSignal.timeout ? AbortSignal.timeout(20000) : undefined;
  const signal = init?.signal && timeout && "any" in AbortSignal
    ? (AbortSignal as unknown as { any: (s: AbortSignal[]) => AbortSignal }).any([init.signal, timeout])
    : init?.signal || timeout;
  return fetch(input, { ...init, signal });
};

/** Browser Supabase client. The session is kept in localStorage so a
 *  signed-in staff member can keep preparing sales while offline. */
export function supabase(): SupabaseClient {
  if (!client) {
    client = createClient(url, anonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: "sw-auth" },
      global: { fetch: smartFetch },
    });
  }
  return client;
}

export const isConfigured = Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
