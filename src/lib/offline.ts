"use client";
import Dexie, { type Table } from "dexie";
import type { PaymentMethod, Product } from "./types";
import { supabase } from "./supabase";
import { isNetworkError, errorMessage } from "./format";

export interface QueuedSale {
  client_tx_id: string;
  business_id: string;
  payload: Record<string, unknown>;
  display: { lines: { name: string; quantity: number; unit_price: string }[]; total: string; paid: string; customer?: string };
  status: "pending" | "syncing" | "error";
  error?: string;
  created_at: string;
  attempts: number;
}

class ShopwiseDB extends Dexie {
  products!: Table<Product, string>;
  methods!: Table<PaymentMethod, string>;
  queue!: Table<QueuedSale, string>;
  meta!: Table<{ key: string; value: unknown }, string>;
  constructor() {
    super("shopwise");
    this.version(1).stores({
      products: "id, business_id",
      methods: "id, business_id",
      queue: "client_tx_id, business_id, status, created_at",
      meta: "key",
    });
  }
}

let _db: ShopwiseDB | null = null;
export function db(): ShopwiseDB {
  if (!_db) _db = new ShopwiseDB();
  return _db;
}

export async function cacheCatalogue(businessId: string, products: Product[], methods: PaymentMethod[]) {
  try {
    await db().transaction("rw", db().products, db().methods, async () => {
      await db().products.where("business_id").equals(businessId).delete();
      await db().products.bulkPut(products);
      await db().methods.where("business_id").equals(businessId).delete();
      await db().methods.bulkPut(methods);
    });
    await db().meta.put({ key: `catalogue:${businessId}`, value: new Date().toISOString() });
  } catch { /* storage may be unavailable (private mode) */ }
}

export async function cachedCatalogue(businessId: string) {
  const [products, methods, meta] = await Promise.all([
    db().products.where("business_id").equals(businessId).toArray(),
    db().methods.where("business_id").equals(businessId).toArray(),
    db().meta.get(`catalogue:${businessId}`),
  ]);
  return { products, methods, cachedAt: (meta?.value as string) || null };
}

export async function queueSale(q: Omit<QueuedSale, "status" | "attempts">) {
  await db().queue.put({ ...q, status: "pending", attempts: 0 });
  notify();
}

// ---------------------------------------------------------------- sync
type Listener = () => void;
const listeners = new Set<Listener>();
export function onQueueChange(fn: Listener) { listeners.add(fn); return () => { listeners.delete(fn); }; }
function notify() { listeners.forEach((l) => l()); }

let syncing = false;
export function isSyncing() { return syncing; }

export interface SyncResult { synced: number; conflicts: number; failed: number }

/** Push queued sales to the server. Safe to call repeatedly: each sale
 *  carries its client_tx_id, so a retry can never create a duplicate. */
export async function syncQueue(): Promise<SyncResult> {
  const result: SyncResult = { synced: 0, conflicts: 0, failed: 0 };
  if (syncing || (typeof navigator !== "undefined" && !navigator.onLine)) return result;
  syncing = true;
  notify();
  try {
    const items = await db().queue.orderBy("created_at").toArray();
    for (const item of items) {
      await db().queue.update(item.client_tx_id, { status: "syncing" });
      notify();
      const { data, error } = await supabase().rpc("finalize_sale", { p: { ...item.payload, offline: true } });
      if (error) {
        if (isNetworkError(error)) {
          await db().queue.update(item.client_tx_id, { status: "pending" });
          break; // connection dropped: try again later
        }
        await db().queue.update(item.client_tx_id, { status: "error", error: errorMessage(error), attempts: item.attempts + 1 });
        result.failed++;
        continue;
      }
      if ((data as { status?: string })?.status === "pending_review") result.conflicts++;
      else result.synced++;
      await db().queue.delete(item.client_tx_id);
      await db().meta.put({ key: `synced:${item.client_tx_id}`, value: (data as { sale_id: string }).sale_id });
      notify();
    }
  } finally {
    syncing = false;
    notify();
  }
  return result;
}

export async function retryItem(id: string) {
  await db().queue.update(id, { status: "pending", error: undefined });
  notify();
  return syncQueue();
}

export async function discardItem(id: string) {
  await db().queue.delete(id);
  notify();
}

export async function syncedSaleId(clientTxId: string): Promise<string | null> {
  const m = await db().meta.get(`synced:${clientTxId}`);
  return (m?.value as string) || null;
}
