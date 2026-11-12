# Shopwise SaaS billing: plan draft (not implemented yet)

Status: **parked**. Frank wants a few more app touches first. Pick this up when he says "payments".

## What Frank decided
- Every new shop gets a **1-month free trial**, then must subscribe from the next month.
- **FRANCONICS STORE never pays** (his own boutique, the first user).
- Offers must be **better, cheaper, faster, more credible** than the competitor TCPOS (tcpos.app). The entry plan is **5,000 XAF/month** and gives more than TCPOS Basic.

## Competitor (TCPOS, Nov 2026)
| Plan | Monthly | Yearly | Products | Users | Customers | Branches |
|---|---|---|---|---|---|---|
| Basic | 6,500 | 65,000 (17% off) | 100 | 2 | 200 | 1 |
| Pro | 11,500 | 120,000 (13% off) | 250 | 4 | 500 | 3 |
| VIP | 14,500 | 150,000 (14% off) | 500 | 8 | 1,000 | 4 |
All of them include "all base modules" and unlimited sales per day.

## Draft Shopwise plans (to confirm with Frank)
| | **Starter** | **Business** (popular) | **Premium** |
|---|---|---|---|
| Monthly | **5,000** | **9,500** | **13,000** |
| Yearly (2 months free) | 50,000 | 95,000 | 130,000 |
| Products | 300 | 1,500 | Unlimited |
| User accounts | 3 | 8 | 20 |
| Customers | Unlimited | Unlimited | Unlimited |
| Shops / branches | 1 (sections unlimited) | 2 | 5 |
| Smart import (AI reads PDF / photo / messy files) | 10 per month | 50 per month | 200 per month |
| Sales | Unlimited | Unlimited | Unlimited |

Every plan includes the POS (offline too), part payments, WhatsApp / PDF receipts, payment proofs, stock & inventory valuation, shifts with clock-in, expenses, approvals, roles & per-section rights, the audit log, CSV export, and import from Excel / CSV / Word.
Each plan beats the TCPOS plan at its level on price **and** limits. Unlimited customers removes a TCPOS selling point.

## Mechanics to build
1. `businesses`: `plan`, `trial_ends_at` (created + 30 days), `paid_until`, `billing_exempt` (true for FRANCONICS STORE, set by the platform admin only).
2. Plan limits enforced **in the database** (products, users, branches, AI reads), not only in the UI.
3. Reminders at 7 / 3 / 1 days before the trial or subscription ends: in-app banner + WhatsApp / email.
4. When unpaid: **3-day grace**, then **read-only** (they can view and export their data, can't record new sales). Data is never deleted or locked away.
5. Payment by MTN MoMo / Orange Money through a Cameroon aggregator (candidates to compare: CamPay, Notch Pay, Monetbil, Fapshi, Flutterwave). v1 can be manual: the customer pays, the platform admin taps "Activate until …".
6. Subscription receipts / invoices, plus a billing page for the super admin (plan, next payment, history, upgrade / downgrade).
7. Public pricing page, plus self sign-up with the trial starting automatically.
8. Platform-admin view: all shops, trial / paid / overdue, revenue.

## Gaps to close before selling against TCPOS
- **Multi-branch** (TCPOS sells 3–4 branches). Today Shopwise has sections inside one shop.
- **Customer list** (TCPOS counts customers). Today customers are only a name and phone on sales.
