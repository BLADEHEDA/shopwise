# Shopwise

Mobile-first point-of-sale and store-management app for retail shops, first deployed for **Frankonic Store, Buea**, and built multi-tenant from day one so it can grow into a SaaS product.

**Stack:** Next.js 15 + TypeScript + Tailwind · Supabase (Postgres, Auth, Storage) · Vercel · installable PWA with an offline sales queue (IndexedDB/Dexie).

The product name is not hard-coded. It is read from the `brand_config` table, so it can be renamed to **Vendora** or **StorePilot** from *Settings → Product branding* without touching data or code.

---

## Go live in about 15 minutes

### 1. Create the database (Supabase)

1. Create a free project at [supabase.com](https://supabase.com) (region: *West EU* or *Frankfurt* is closest to Cameroon).
2. **Database tables are created and upgraded automatically** on every production deploy (`scripts/migrate.mjs` runs every file in `supabase/migrations/` that hasn't run yet). You only need to give Vercel the database address once: see `DATABASE_URL` below. *(Older setup: pasting the SQL files into the SQL editor still works; the script detects that and continues from there.)*
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
   | `DATABASE_URL` | Supabase → **Connect** → *Session pooler* connection string, with `[YOUR-PASSWORD]` replaced by your database password. Used only during the build to upgrade the database; never sent to browsers. |

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

## Preparing an inventory sheet for import

Any shop can upload its own **Excel (.xlsx), CSV or PDF** (a PDF *exported* from Excel/Google Sheets; scanned photos can't be read). Nobody runs SQL: it's all in **Inventory → Import stock**. It works if:

1. **There is a heading row** with at least a name column: `Item` / `Name` / `Product`. Optional: `Cost Price`, `Quantity`, `Selling price` / `Target price`, `Min price`, `Category`, `Section`, `Brand`, `SKU`.
2. **One product per row.** Numbers only in number columns (`1,500` and `1500 FCFA` are fine).
3. **Categories** can be a column, or a heading row above each block (`PHONE CHARGERS`, `Smart Watch`: any capitalisation).
4. **Ignored automatically:** title rows above the headings, blank rows, `Total` / `Grand total` rows, an `Amount` column, and blocks whose heading contains *Expenses*.
5. **Short names** like `2GB` or `P9` get their category added (`USB Key 2GB`): there's a switch for this on the import screen.
6. **Same name twice** in one file is numbered (`… (2)`) and flagged so you can rename it.
7. **Selling prices are optional**; products without one stay off the POS until a price is set.
8. Importing the same sheet again with **Import stock** adds the quantities (no duplicates), as long as product names stay the same.

To start over after importing the wrong file (removes only products never sold or purchased):
```sql
select remove_unsold_products('YOUR BUSINESS NAME');
```

## Demo shop for testers (optional)

Let people try the app without signing up:

1. Run `supabase/migrations/0004_demo_and_feedback.sql` (if not done yet), then in the SQL editor run:
   ```sql
   select demo_reset();
   ```
   This creates **Demo Shop (test data)**: about 19 sample products, a week of sales, an imported batch, a pending price override, a pending expense, a low-stock report and an offline sale to review. It also creates three shared logins (password `ShopwiseDemo1`):
   - `demo.admin@example.com`: Super admin
   - `demo.shopowner@example.com`: Shop owner (Phones & Tablets only)
   - `demo.shopkeeper@example.com`: Shopkeeper (Accessories only)
2. The sign-in page now shows **Try the demo** buttons: one tap, no typing.
3. Testers send comments from **Menu → Feedback**. Platform admins read them all on the same page (with export to CSV).
4. Demo logins can't change their email or password, and can't be disabled, so testers can't lock each other out. The demo is a separate business: testers never see real shops.
5. **Reset** the demo to fresh data any time: *Settings → Demo shop → Reset demo data* (platform admin) or `select demo_reset();`.
6. **Before the real launch**, remove it completely: `select demo_remove();`. The buttons disappear from the sign-in page.

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
