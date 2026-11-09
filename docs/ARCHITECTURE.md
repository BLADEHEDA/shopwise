# Architecture

## Principles

- **The database is the authority.** Every money/stock operation (sale, payment, void, override decision, stock adjustment, purchase receipt, expense decision, import) is a Postgres function (`SECURITY DEFINER`) that checks permissions, validates, and writes in **one transaction**. The browser never writes stock or money tables directly.
- **Tenant isolation in the database.** Every business-owned row has `business_id`. Row-level security (RLS) is enabled on every table; with no matching policy, access is denied.
- **Secrets live in separate tables.** Cost prices are in `product_costs` and `sale_line_costs`, which have stricter RLS than `products`/`sale_lines`, so staff can't fetch costs even by calling the API directly.
- **Column-level grants.** `products.stock_qty` is not updatable by clients; stock only changes through stock functions, which always write a `stock_movements` ledger row.
- **Money:** `numeric(14,2)` in the database; integer minor units on the client for live totals. FCFA is displayed as whole numbers.
- **Idempotency:** every sale has a client-generated `client_tx_id` (unique). Retrying, whether offline sync, a timeout or a double tap, returns the original sale.

## Data model

```
businesses ─┬─ sections ─────────────┐
            ├─ memberships ── membership_sections
            ├─ invitations           │
            ├─ payment_methods       │
            ├─ categories            │
            ├─ products (section) ───┤── product_costs (avg_cost, owner-only)
            ├─ suppliers             │
            ├─ purchases (section) ── purchase_lines (landed_unit_cost)
            ├─ stock_movements (immutable ledger)
            ├─ stock_flags (staff reports)
            ├─ shifts
            ├─ price_override_requests
            ├─ sales ─┬─ sale_lines (section, actual price) ── sale_line_costs (cost basis)
            │         └─ payments (method, amount, reference)
            ├─ expenses (section or whole business)
            └─ audit_log
profiles (1:1 auth.users) · platform_admins · brand_config (single row)
```

**Weighted average cost:** on every receipt, `avg = (old_qty × old_avg + qty × landed_cost) ÷ (old_qty + qty)`. Each sale line stores the cost basis at the moment of sale, so historical profit never changes when costs move later.

**Landed cost:** `unit_local = unit_price × exchange_rate`; extra costs (freight + other) are allocated by line value or quantity; rounding remainder goes to the last line so totals are exact.

## Role-permission matrix

Scope = the sections assigned to the membership (owners and "all sections" members see every section).

| Capability | Owner | Section owner | Manager | Sales staff | Accountant |
|---|---|---|---|---|---|
| See catalogue, target & minimum prices | ✓ all | ✓ all | ✓ all | ✓ all | ✓ all |
| See cost prices, margins, suppliers, purchases | ✓ all | ✓ own sections¹ | optional, scoped² | ✗ never | optional, scoped² |
| Sell at POS | ✓ | ✓ scoped | ✓ scoped | ✓ scoped | ✗ |
| Sell below minimum | approve | approve (own sections) | request | request | ✗ |
| Add/edit products & prices | ✓ | ✓ scoped | ✓ scoped | ✗ | ✗ |
| Adjust stock, record damage | ✓ | ✓ scoped | ✓ scoped | report only | ✗ |
| Receive purchases | ✓ | ✓ scoped + costs | ✓ scoped + costs² | ✗ | ✗ |
| See sales | all | sales touching own sections | sales touching scope | own only | scoped |
| Void sale / resolve offline conflict | ✓ | ✓ if every line is in own sections | ✗ | ✗ | ✗ |
| Expenses | approve all | approve own sections | approve if financial access² | submit (pending) | view scoped |
| Reports | consolidated + per section, with profit | own sections, with profit¹ | scoped, revenue (profit if²) | own performance, no costs | scoped (profit if²) |
| Team, invites, roles | ✓ | ✗ | ✗ | ✗ | ✗ |
| Business settings, sections, payment methods | ✓ | ✗ | ✗ | ✗ | ✗ |
| Audit log | ✓ | ✗ | ✗ | ✗ | ✗ |
| Product branding | platform admin only ||||

¹ on by default for section owners; the owner can switch it off. ² "Financial access" toggle per member, off by default.

Sales staff can never be given cost access. A database constraint enforces this.

## Offline design

1. The service worker caches the app shell; the POS caches products, prices and payment methods in IndexedDB on every online load.
2. A sale made offline (or when the request fails with a network error) is stored in the `queue` table with its `client_tx_id`. Below-minimum (override) sales can't be queued; they need the owner online.
3. The queue syncs on reconnect, every 30 seconds, and when the app opens. `finalize_sale` runs with `offline=true`: if stock, price or shift conditions changed, the sale is saved as **pending review** (no stock moved) and appears in *Approvals* for the owner to accept or reject.
4. Duplicates are impossible: the server returns the existing sale for a repeated `client_tx_id`.
5. Nothing sensitive (stock balances, costs, permissions, settings) can be changed offline.

## Key files

| Path | Purpose |
|---|---|
| `supabase/migrations/0001_shopwise.sql` | Schema, RLS, functions, storage bucket |
| `supabase/tests/acceptance.sql` | Database acceptance tests (scratch DB only) |
| `src/lib/brand-defaults.ts` | The only place the default product name appears |
| `src/lib/offline.ts` | IndexedDB catalogue cache and sale queue + sync |
| `src/lib/money.ts` | Integer-safe money helpers |
| `src/components/biz.tsx` | Session, business context and client-side permission mirror (UI only; the server enforces) |
| `src/app/app/pos/page.tsx` | POS, cart, override requests, payments |
| `public/sw.js` | Service worker |
