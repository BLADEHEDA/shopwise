# Shopwise

Mobile-first point-of-sale and store-management app for retail shops, first deployed for **Frankonic Store, Buea**, and built multi-tenant from day one so it can grow into a SaaS product.

**Stack:** Next.js 15 + TypeScript + Tailwind · Supabase (Postgres, Auth, Storage) · Vercel · installable PWA with an offline sales queue (IndexedDB/Dexie).

The product name is not hard-coded. It is read from the `brand_config` table, so it can be renamed to **Vendora** or **StorePilot** from *Settings → Product branding* without touching data or code.

---

## Go live in about 15 minutes

### 1. Create the database (Supabase)

1. Create a free project at [supabase.com](https://supabase.com) (region: *West EU* or *Frankfurt* is closest to Cameroon).
2. Open **SQL Editor → New query**, paste the whole of [`supabase/migrations/0001_shopwise.sql`](supabase/migrations/0001_shopwise.sql) and click **Run**. This creates every table, the security rules (RLS), the transaction functions and the `shopwise` storage bucket for images. Then do the same, in order, for every later file in `supabase/migrations/` (`0002_…`, `0003_…`). Each later file is safe to run more than once.
3. **Authentication → URL Configuration**: set **Site URL** to your Vercel URL (e.g. `https://shopwise.vercel.app`) and add `https://shopwise.vercel.app/**` to **Redirect URLs**.
4. *(Optional, faster onboarding)* **Authentication → Sign In / Providers → Email**: turn off **Confirm email** so new staff can sign in immediately after accepting an invite. Leave it on if you want email verification.
5. **Project Settings → API**: copy the **Project URL** and the **anon public** key.
6. **Before real launch: set up email (custom SMTP).** Supabase's built-in email only delivers to members of your Supabase team, and only a couple per hour. Password-reset and change-email messages to your staff need a custom SMTP provider (e.g. Brevo or Resend, both with free tiers): **Authentication → Emails → SMTP Settings**. Invitations don't need email: you send the link on WhatsApp.

> ⚠️ Do **not** run `supabase/tests/acceptance.sql` on your real database. It creates test users and is only for a scratch database.

### 2. Deploy the app (Vercel)

1. At [vercel.com/new](https://vercel.com/new), import the `shopwise` GitHub repository (framework: Next.js, default settings).
2. Add two **Environment Variables**:

   | Name | Value |
   |---|---|
   | `NEXT_PUBLIC_SUPABASE_URL` | your Project URL |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | your anon public key |

3. Click **Deploy**. Then go back to Supabase step 3 and put in the real Vercel URL.

### 3. First use

1. Open the site → **Create a business** → sign up → enter *Frankonic Store* and your sections (Electronics, Components). Cash, MTN Mobile Money and Orange Money are created automatically.
2. **Products → Import**: download the template, fill it in Excel, and upload it (preview, column matching and validation happen before anything is saved).
3. **Settings → Team & permissions → Invite someone**: enter their email, pick the role (**Super admin**, **Shop owner**, **Shopkeeper**, Manager, Accountant) and tick their sections, then send the link by WhatsApp. They open it, type their name and choose their own password; that's it. Invitations are single-use, tied to that email, and expire after 7 days. Several people can be Super admin with identical rights; each has their own login, so the app always records who did what.
   Everyone can change their own login email and password in **Settings → Login & security** (the current password is always required).
4. Make yourself **platform administrator** (needed only for rebranding). Run this once in the SQL editor:
   ```sql
   insert into platform_admins (user_id)
   select user_id from profiles where email = 'you@example.com';
   ```
5. On Android, open the site in Chrome → menu → **Install app** / **Add to Home screen**.

---

## What's included (MVP / P0 + most of P1)

| Area | What works |
|---|---|
| **POS** | Search by name/brand/model/SKU/barcode (scanner + Enter works), section filter, cart, quantity, negotiated price per line, live totals |
| **Price controls** | Target price, minimum price, owner-only cost. Below-minimum is blocked; staff request approval; the owner approves an *exact* price or declines; the approval is single-use and never changes the product's minimum |
| **Payments** | Split payments (e.g. 5,000 cash + 3,000 MTN MoMo), mobile-money reference numbers, partial payment with balance due, later "record payment of balance" |
| **Receipts** | Digital receipt; share as an image (WhatsApp etc.), download PNG, print/save PDF |
| **Stock** | Decremented in the same database transaction as the sale; full movement ledger (opening, purchase, sale, adjustment, damage, return, void); low-stock alerts; staff can report "low" or "arrived" |
| **Purchases** | Purchase batches with supplier, local/imported, currency and exchange rate, freight/other costs allocated by value or quantity, landed unit cost, **weighted average cost** |
| **Shifts** | Clock in/out; every sale linked to its shift; policy: block or flag sales without a shift; managers can close forgotten shifts (audited) |
| **Expenses** | Staff claims stay *pending*; owners/authorised managers approve or reject; only approved expenses reduce net profit |
| **Reports** | Revenue, collected, outstanding, COGS, gross profit, expenses, net operating result; by day, product, staff, shift, payment method and section; CSV export. Staff see only their own performance |
| **Permissions** | Owner, section owner (partner), manager, sales staff, read-only accountant. Scoped by business **and** section, enforced in Postgres row-level security, not just hidden in the UI |
| **Offline** | Installable PWA. The app shell and catalogue are cached; sales are queued in IndexedDB with idempotency keys, sync automatically, and conflicts (stock/price/shift) go to owner review instead of corrupting stock |
| **Audit** | Price overrides, voids, stock adjustments, cost changes, expense decisions, role changes, shift corrections and brand changes |
| **Multi-tenant** | Every row carries `business_id`; one user can belong to several businesses; sections, roles and payment methods are configurable records |
| **Branding** | Product name, logo, app icon, colour and support contacts from one config row; the PWA manifest and icons follow it |

**Later (P2):** subscription billing, public self-service signup controls, barcode-printer/receipt-printer hardware, inter-section transfers, supplier purchase orders, multi-branch, staff targets/bonuses, accounting integrations.

---

## Decisions taken (from §14 of the brief, all easy to change)

- **Clock policy:** staff must clock in before selling (switchable to "allow but flag" in Settings).
- **Offline conflicts:** held for owner review (accept → stock taken; reject → marked refunded).
- **Landed cost:** allocated by item value by default (quantity optional); the method is stored on each batch.
- **Refunds/returns:** owner (or the owner of every section in the sale) can void a completed sale with a reason; stock is returned and the action is audited. Partial returns: use *Inventory → Adjust → Customer return*.
- **Overpayment:** recorded payments can't exceed the sale total; give change in cash outside the system.
- **Currency/timezone:** FCFA (XAF), Africa/Douala; stored per business.
- **Colours:** Royal Blue `#3158C9` primary, neutral greys, semantic status colours only, no teal.

## Develop locally

```bash
npm install
cp .env.example .env.local   # fill in your Supabase URL + anon key
npm run dev
```

Database acceptance tests (80 checks: permissions, atomic sales, idempotency, overrides, WAC, landed cost, offline conflicts, expenses, reports, voids, import, tenant isolation, rebranding) live in `supabase/tests/acceptance.sql`. Run them against a **fresh scratch** Postgres with the migration applied.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the data model and the role-permission matrix.
