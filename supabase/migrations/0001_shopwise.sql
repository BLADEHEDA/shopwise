-- =====================================================================
-- Shopwise — schema, row-level security and transactional functions
-- Target: Supabase Postgres (15+). Run once in the Supabase SQL editor.
-- Money: numeric(14,2). Quantities: integer. Timestamps: timestamptz.
-- Every business-owned row carries business_id (tenant isolation).
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Platform level
-- ---------------------------------------------------------------------
create table public.profiles (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  email      text,
  full_name  text,
  phone      text,
  created_at timestamptz not null default now()
);

create table public.platform_admins (
  user_id uuid primary key references public.profiles(user_id) on delete cascade
);

-- Single-row public brand configuration (Shopwise -> Vendora / StorePilot)
create table public.brand_config (
  id            int primary key default 1 check (id = 1),
  product_name  text not null default 'Shopwise',
  tagline       text not null default 'Sell smarter. Know your numbers.',
  logo_url      text,
  icon_url      text,
  primary_color text not null default '#3158C9'
                check (primary_color ~ '^#[0-9A-Fa-f]{6}$'),
  support_email text,
  support_phone text,
  updated_at    timestamptz not null default now(),
  updated_by    uuid
);
insert into public.brand_config (id) values (1);

-- ---------------------------------------------------------------------
-- Tenants, sections, memberships
-- ---------------------------------------------------------------------
create table public.businesses (
  id             uuid primary key default gen_random_uuid(),
  name           text not null check (length(trim(name)) between 2 and 120),
  currency       text not null default 'XAF',
  timezone       text not null default 'Africa/Douala',
  logo_url       text,
  accent_color   text check (accent_color is null or accent_color ~ '^#[0-9A-Fa-f]{6}$'),
  phone          text,
  address        text,
  receipt_footer text default 'Thank you for shopping with us!',
  require_shift  boolean not null default true,   -- block sales without an active shift
  receipt_seq    bigint not null default 0,
  plan           text not null default 'pilot',
  created_by     uuid references public.profiles(user_id),
  created_at     timestamptz not null default now()
);

create table public.sections (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name        text not null check (length(trim(name)) between 1 and 60),
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  unique (business_id, name),
  unique (business_id, id)
);

create table public.memberships (
  id             uuid primary key default gen_random_uuid(),
  business_id    uuid not null references public.businesses(id) on delete cascade,
  user_id        uuid not null references public.profiles(user_id) on delete cascade,
  role           text not null check (role in ('owner','section_owner','manager','staff','accountant')),
  all_sections   boolean not null default false,
  can_view_costs boolean not null default false,
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  unique (business_id, user_id),
  -- sales staff can never see cost prices
  check (not (role = 'staff' and can_view_costs))
);

create table public.membership_sections (
  membership_id uuid not null references public.memberships(id) on delete cascade,
  section_id    uuid not null references public.sections(id) on delete cascade,
  business_id   uuid not null references public.businesses(id) on delete cascade,
  primary key (membership_id, section_id)
);

create table public.invitations (
  id             uuid primary key default gen_random_uuid(),
  business_id    uuid not null references public.businesses(id) on delete cascade,
  email          text not null,
  role           text not null check (role in ('owner','section_owner','manager','staff','accountant')),
  all_sections   boolean not null default false,
  section_ids    uuid[] not null default '{}',
  can_view_costs boolean not null default false,
  token          uuid not null unique default gen_random_uuid(),
  expires_at     timestamptz not null default now() + interval '7 days',
  accepted_at    timestamptz,
  revoked_at     timestamptz,
  invited_by     uuid references public.profiles(user_id),
  created_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Catalogue
-- ---------------------------------------------------------------------
create table public.payment_methods (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name        text not null,
  kind        text not null default 'other' check (kind in ('cash','mobile_money','card','bank','other')),
  active      boolean not null default true,
  sort        int not null default 0,
  unique (business_id, name)
);

create table public.categories (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name        text not null,
  unique (business_id, name)
);

create table public.products (
  id                  uuid primary key default gen_random_uuid(),
  business_id         uuid not null references public.businesses(id) on delete cascade,
  section_id          uuid not null,
  category_id         uuid references public.categories(id) on delete set null,
  parent_id           uuid references public.products(id) on delete set null, -- variants
  variant_label       text,
  name                text not null check (length(trim(name)) between 1 and 160),
  brand               text,
  model               text,
  sku                 text,
  barcode             text,
  description         text,
  specs               jsonb not null default '{}'::jsonb,
  image_url           text,
  target_price        numeric(14,2) not null check (target_price > 0),
  min_price           numeric(14,2) not null check (min_price > 0),
  stock_qty           integer not null default 0,
  low_stock_threshold integer not null default 3 check (low_stock_threshold >= 0),
  active              boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  foreign key (business_id, section_id) references public.sections(business_id, id),
  check (min_price <= target_price),
  check (stock_qty >= 0)
);
create unique index products_sku_uq on public.products (business_id, lower(sku)) where sku is not null and sku <> '';
create index products_business_idx on public.products (business_id, section_id, active);

-- Owner-only cost basis (weighted average landed cost). Separate table so
-- row-level security can hide it from staff even though products are visible.
create table public.product_costs (
  product_id  uuid primary key references public.products(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  section_id  uuid not null,
  avg_cost    numeric(14,2) not null default 0 check (avg_cost >= 0),
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Purchasing & stock ledger
-- ---------------------------------------------------------------------
create table public.suppliers (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name        text not null,
  country     text,
  phone       text,
  notes       text,
  created_at  timestamptz not null default now(),
  unique (business_id, name)
);

create table public.purchases (
  id                uuid primary key default gen_random_uuid(),
  business_id       uuid not null references public.businesses(id) on delete cascade,
  section_id        uuid not null,
  supplier_id       uuid references public.suppliers(id),
  source            text not null default 'local' check (source in ('local','import')),
  currency          text not null default 'XAF',
  exchange_rate     numeric(14,6) not null default 1 check (exchange_rate > 0),
  purchase_date     date not null default current_date,
  freight_cost      numeric(14,2) not null default 0 check (freight_cost >= 0),
  other_costs       numeric(14,2) not null default 0 check (other_costs >= 0),
  allocation_method text not null default 'value' check (allocation_method in ('value','quantity')),
  reference         text,
  notes             text,
  created_by        uuid references public.profiles(user_id),
  created_at        timestamptz not null default now()
);

create table public.purchase_lines (
  id               uuid primary key default gen_random_uuid(),
  purchase_id      uuid not null references public.purchases(id) on delete cascade,
  business_id      uuid not null references public.businesses(id) on delete cascade,
  product_id       uuid not null references public.products(id),
  quantity         integer not null check (quantity > 0),
  unit_price       numeric(14,2) not null check (unit_price >= 0),  -- in purchase currency
  unit_price_local numeric(14,2) not null,                          -- converted
  allocated_extra  numeric(14,2) not null default 0,                -- share of freight/other
  landed_unit_cost numeric(14,2) not null
);

create table public.stock_movements (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references public.businesses(id) on delete cascade,
  section_id    uuid not null,
  product_id    uuid not null references public.products(id),
  kind          text not null check (kind in ('opening','purchase','sale','return','adjustment','damage','transfer','void','review_accept')),
  qty_change    integer not null check (qty_change <> 0),
  balance_after integer not null,
  ref_type      text,
  ref_id        uuid,
  reason        text,
  created_by    uuid references public.profiles(user_id),
  created_at    timestamptz not null default now()
);
create index stock_movements_product_idx on public.stock_movements (product_id, created_at desc);
create index stock_movements_business_idx on public.stock_movements (business_id, created_at desc);

create table public.stock_flags (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  product_id  uuid not null references public.products(id) on delete cascade,
  kind        text not null check (kind in ('low','arrived')),
  note        text,
  created_by  uuid references public.profiles(user_id),
  created_at  timestamptz not null default now(),
  resolved_by uuid references public.profiles(user_id),
  resolved_at timestamptz
);

-- ---------------------------------------------------------------------
-- Shifts, sales, payments, overrides
-- ---------------------------------------------------------------------
create table public.shifts (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  user_id     uuid not null references public.profiles(user_id),
  started_at  timestamptz not null default now(),
  ended_at    timestamptz,
  closed_by   uuid references public.profiles(user_id),
  note        text,
  check (ended_at is null or ended_at >= started_at)
);
create unique index shifts_one_open_uq on public.shifts (business_id, user_id) where ended_at is null;
create index shifts_business_idx on public.shifts (business_id, started_at desc);

create table public.price_override_requests (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references public.businesses(id) on delete cascade,
  section_id      uuid not null,
  product_id      uuid not null references public.products(id),
  requested_by    uuid not null references public.profiles(user_id),
  requested_price numeric(14,2) not null check (requested_price > 0),
  quantity        integer not null default 1 check (quantity > 0),
  reason          text,
  status          text not null default 'pending' check (status in ('pending','approved','rejected','used','cancelled')),
  approved_price  numeric(14,2),
  decided_by      uuid references public.profiles(user_id),
  decided_at      timestamptz,
  decision_note   text,
  sale_id         uuid,
  created_at      timestamptz not null default now()
);
create index overrides_business_idx on public.price_override_requests (business_id, status, created_at desc);

create table public.sales (
  id               uuid primary key default gen_random_uuid(),
  business_id      uuid not null references public.businesses(id) on delete cascade,
  receipt_no       bigint not null,
  client_tx_id     uuid not null unique,                -- idempotency key
  staff_user_id    uuid not null references public.profiles(user_id),
  shift_id         uuid references public.shifts(id),
  no_shift         boolean not null default false,      -- flagged: sold without active shift
  customer_name    text,
  customer_phone   text,
  total            numeric(14,2) not null check (total >= 0),
  amount_paid      numeric(14,2) not null default 0 check (amount_paid >= 0),
  balance_due      numeric(14,2) not null default 0 check (balance_due >= 0),
  payment_status   text not null check (payment_status in ('unpaid','partial','paid','voided','refunded')),
  status           text not null check (status in ('completed','pending_review','voided','rejected')),
  conflicts        text[] not null default '{}',
  offline          boolean not null default false,
  note             text,
  sold_at          timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  decided_by       uuid references public.profiles(user_id),
  decided_at       timestamptz,
  decision_reason  text,
  unique (business_id, receipt_no),
  check (amount_paid <= total)
);
create index sales_business_idx on public.sales (business_id, sold_at desc);
create index sales_staff_idx on public.sales (business_id, staff_user_id, sold_at desc);

create table public.sale_lines (
  id            uuid primary key default gen_random_uuid(),
  sale_id       uuid not null references public.sales(id) on delete cascade,
  business_id   uuid not null references public.businesses(id) on delete cascade,
  section_id    uuid not null,
  product_id    uuid not null references public.products(id),
  product_name  text not null,
  quantity      integer not null check (quantity > 0),
  target_price  numeric(14,2) not null,
  min_price     numeric(14,2) not null,
  unit_price    numeric(14,2) not null check (unit_price > 0),
  line_total    numeric(14,2) not null,
  override_id   uuid references public.price_override_requests(id)
);
create index sale_lines_sale_idx on public.sale_lines (sale_id);
create index sale_lines_section_idx on public.sale_lines (business_id, section_id);

-- Cost of goods per sold line, hidden from staff via RLS.
create table public.sale_line_costs (
  sale_line_id uuid primary key references public.sale_lines(id) on delete cascade,
  business_id  uuid not null references public.businesses(id) on delete cascade,
  section_id   uuid not null,
  unit_cost    numeric(14,2) not null,
  cost_total   numeric(14,2) not null
);

create table public.payments (
  id           uuid primary key default gen_random_uuid(),
  sale_id      uuid not null references public.sales(id) on delete cascade,
  business_id  uuid not null references public.businesses(id) on delete cascade,
  method_id    uuid not null references public.payment_methods(id),
  method_name  text not null,
  amount       numeric(14,2) not null check (amount > 0),
  reference    text,
  received_by  uuid references public.profiles(user_id),
  created_at   timestamptz not null default now()
);
create index payments_sale_idx on public.payments (sale_id);
create index payments_business_idx on public.payments (business_id, created_at desc);

-- ---------------------------------------------------------------------
-- Expenses & audit
-- ---------------------------------------------------------------------
create table public.expenses (
  id             uuid primary key default gen_random_uuid(),
  business_id    uuid not null references public.businesses(id) on delete cascade,
  section_id     uuid,                                   -- null = whole business
  category       text not null,
  amount         numeric(14,2) not null check (amount > 0),
  expense_date   date not null default current_date,
  description    text,
  payment_method text,
  attachment_url text,
  status         text not null default 'pending' check (status in ('pending','approved','rejected')),
  submitted_by   uuid not null references public.profiles(user_id),
  decided_by     uuid references public.profiles(user_id),
  decided_at     timestamptz,
  decision_note  text,
  created_at     timestamptz not null default now()
);
create index expenses_business_idx on public.expenses (business_id, expense_date desc);

create table public.audit_log (
  id          bigint generated always as identity primary key,
  business_id uuid references public.businesses(id) on delete cascade,
  actor_id    uuid,
  action      text not null,
  entity      text,
  entity_id   uuid,
  details     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index audit_business_idx on public.audit_log (business_id, created_at desc);

-- =====================================================================
-- Permission helpers (SECURITY DEFINER so they can read memberships
-- without recursive RLS). All take the business id explicitly.
-- =====================================================================
create or replace function public.my_role(b uuid) returns text
language sql stable security definer set search_path = public as $$
  select role from memberships where business_id = b and user_id = auth.uid() and active
$$;

create or replace function public.is_member(b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from memberships where business_id = b and user_id = auth.uid() and active)
$$;

create or replace function public.is_owner(b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from memberships where business_id = b and user_id = auth.uid() and active and role = 'owner')
$$;

create or replace function public.has_section(b uuid, s uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from memberships m
    where m.business_id = b and m.user_id = auth.uid() and m.active
      and (m.role = 'owner' or m.all_sections
           or (s is not null and exists (select 1 from membership_sections ms
                                          where ms.membership_id = m.id and ms.section_id = s))))
$$;

-- cost prices, margins, suppliers, purchase batches
create or replace function public.can_view_costs(b uuid, s uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from memberships m
    where m.business_id = b and m.user_id = auth.uid() and m.active
      and (m.role = 'owner'
           or (m.role in ('section_owner','manager','accountant') and m.can_view_costs
               and public.has_section(b, s))))
$$;

-- products, prices, stock receiving & adjustments
create or replace function public.can_manage(b uuid, s uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.my_role(b) = 'owner'
      or (public.my_role(b) in ('section_owner','manager') and public.has_section(b, s))
$$;

-- price overrides, voids, offline-conflict review
create or replace function public.can_approve(b uuid, s uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.my_role(b) = 'owner'
      or (public.my_role(b) = 'section_owner' and public.has_section(b, s))
$$;

-- expenses: owners, section owners, and managers with financial access
create or replace function public.can_approve_expense(b uuid, s uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.can_approve(b, s)
      or (public.my_role(b) = 'manager' and public.can_view_costs(b, s))
$$;

-- section-level reports (revenue, staff, stock)
create or replace function public.can_report(b uuid, s uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.my_role(b) = 'owner'
      or (public.my_role(b) in ('section_owner','manager','accountant') and public.has_section(b, s))
$$;

create or replace function public.can_view_sale(p_sale uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from sales s
    where s.id = p_sale
      and (s.staff_user_id = auth.uid()
           or public.is_owner(s.business_id)
           or exists (select 1 from sale_lines l where l.sale_id = s.id
                       and public.can_report(s.business_id, l.section_id))))
$$;

create or replace function public.is_platform_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from platform_admins where user_id = auth.uid())
$$;

create or replace function public.audit(b uuid, act text, ent text, ent_id uuid, det jsonb default '{}'::jsonb)
returns void language sql security definer set search_path = public as $$
  insert into audit_log (business_id, actor_id, action, entity, entity_id, details)
  values (b, auth.uid(), act, ent, ent_id, coalesce(det, '{}'::jsonb))
$$;

-- =====================================================================
-- Triggers
-- =====================================================================
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (user_id, email, full_name, phone)
  values (new.id, lower(new.email), coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
          new.raw_user_meta_data->>'phone')
  on conflict (user_id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.products_audit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := now();
  if (new.target_price, new.min_price) is distinct from (old.target_price, old.min_price) then
    perform audit(new.business_id, 'product_price_changed', 'product', new.id,
      jsonb_build_object('before', jsonb_build_object('target', old.target_price, 'min', old.min_price),
                         'after',  jsonb_build_object('target', new.target_price, 'min', new.min_price)));
  end if;
  if new.section_id is distinct from old.section_id then
    update product_costs set section_id = new.section_id where product_id = new.id;
  end if;
  return new;
end $$;
create trigger products_before_update before update on public.products
  for each row execute function public.products_audit();

-- keep product_costs row in sync for every product
create or replace function public.products_after_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into product_costs (product_id, business_id, section_id, avg_cost)
  values (new.id, new.business_id, new.section_id, 0) on conflict do nothing;
  return new;
end $$;
create trigger products_after_insert after insert on public.products
  for each row execute function public.products_after_insert();

-- =====================================================================
-- Row-level security
-- =====================================================================
alter table public.profiles                enable row level security;
alter table public.platform_admins         enable row level security;
alter table public.brand_config            enable row level security;
alter table public.businesses              enable row level security;
alter table public.sections                enable row level security;
alter table public.memberships             enable row level security;
alter table public.membership_sections     enable row level security;
alter table public.invitations             enable row level security;
alter table public.payment_methods         enable row level security;
alter table public.categories              enable row level security;
alter table public.products                enable row level security;
alter table public.product_costs           enable row level security;
alter table public.suppliers               enable row level security;
alter table public.purchases               enable row level security;
alter table public.purchase_lines          enable row level security;
alter table public.stock_movements         enable row level security;
alter table public.stock_flags             enable row level security;
alter table public.shifts                  enable row level security;
alter table public.price_override_requests enable row level security;
alter table public.sales                   enable row level security;
alter table public.sale_lines              enable row level security;
alter table public.sale_line_costs         enable row level security;
alter table public.payments                enable row level security;
alter table public.expenses                enable row level security;
alter table public.audit_log               enable row level security;

-- Lock everything down first, then grant precisely.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated, public;
grant select on all tables in schema public to authenticated;
grant select on public.brand_config to anon;

-- profiles: self, or people who share a business with me
create policy profiles_select on public.profiles for select using (
  user_id = auth.uid()
  or exists (select 1 from memberships a join memberships b on a.business_id = b.business_id
             where a.user_id = auth.uid() and a.active and b.user_id = profiles.user_id));
grant update (full_name, phone) on public.profiles to authenticated;
create policy profiles_update on public.profiles for update using (user_id = auth.uid());

create policy platform_admins_select on public.platform_admins for select using (user_id = auth.uid());
create policy brand_select on public.brand_config for select using (true);

create policy businesses_select on public.businesses for select using (public.is_member(id));
grant update (name, logo_url, accent_color, phone, address, receipt_footer, require_shift, timezone)
  on public.businesses to authenticated;
create policy businesses_update on public.businesses for update using (public.is_owner(id));

create policy sections_select on public.sections for select using (public.is_member(business_id));
grant insert (business_id, name), update (name, active) on public.sections to authenticated;
create policy sections_insert on public.sections for insert with check (public.is_owner(business_id));
create policy sections_update on public.sections for update using (public.is_owner(business_id));

create policy memberships_select on public.memberships for select using (public.is_member(business_id));
create policy membership_sections_select on public.membership_sections for select using (public.is_member(business_id));
create policy invitations_select on public.invitations for select using (public.is_owner(business_id));

create policy payment_methods_select on public.payment_methods for select using (public.is_member(business_id));
grant insert (business_id, name, kind, sort), update (name, kind, active, sort) on public.payment_methods to authenticated;
create policy payment_methods_insert on public.payment_methods for insert with check (public.is_owner(business_id));
create policy payment_methods_update on public.payment_methods for update using (public.is_owner(business_id));

create policy categories_select on public.categories for select using (public.is_member(business_id));
grant insert (business_id, name) on public.categories to authenticated;
create policy categories_insert on public.categories for insert with check (
  public.my_role(business_id) in ('owner','section_owner','manager'));

-- products: every member can see the catalogue (target + minimum price only).
-- stock_qty is NOT writable directly: only through stock functions.
create policy products_select on public.products for select using (public.is_member(business_id));
grant insert (business_id, section_id, category_id, parent_id, variant_label, name, brand, model, sku, barcode,
              description, specs, image_url, target_price, min_price, low_stock_threshold, active)
  on public.products to authenticated;
grant update (section_id, category_id, parent_id, variant_label, name, brand, model, sku, barcode,
              description, specs, image_url, target_price, min_price, low_stock_threshold, active)
  on public.products to authenticated;
create policy products_insert on public.products for insert with check (public.can_manage(business_id, section_id));
create policy products_update on public.products for update
  using (public.can_manage(business_id, section_id)) with check (public.can_manage(business_id, section_id));

create policy product_costs_select on public.product_costs for select using (public.can_view_costs(business_id, section_id));

create policy suppliers_select on public.suppliers for select using (
  public.is_owner(business_id) or (public.my_role(business_id) in ('section_owner','manager','accountant')
    and exists (select 1 from memberships m where m.business_id = suppliers.business_id
                and m.user_id = auth.uid() and m.can_view_costs)));
grant insert (business_id, name, country, phone, notes), update (name, country, phone, notes) on public.suppliers to authenticated;
create policy suppliers_insert on public.suppliers for insert with check (
  public.is_owner(business_id) or exists (select 1 from memberships m where m.business_id = suppliers.business_id
    and m.user_id = auth.uid() and m.active and m.can_view_costs and m.role in ('section_owner','manager')));
create policy suppliers_update on public.suppliers for update using (public.is_owner(business_id));

create policy purchases_select on public.purchases for select using (public.can_view_costs(business_id, section_id));
create policy purchase_lines_select on public.purchase_lines for select using (
  exists (select 1 from purchases p where p.id = purchase_id and public.can_view_costs(p.business_id, p.section_id)));

create policy stock_movements_select on public.stock_movements for select using (
  public.can_manage(business_id, section_id) or public.can_report(business_id, section_id));

create policy stock_flags_select on public.stock_flags for select using (
  created_by = auth.uid() or public.my_role(business_id) in ('owner','section_owner','manager'));

create policy shifts_select on public.shifts for select using (
  user_id = auth.uid() or public.my_role(business_id) in ('owner','section_owner','manager','accountant'));

create policy overrides_select on public.price_override_requests for select using (
  requested_by = auth.uid() or public.can_approve(business_id, section_id));

create policy sales_select on public.sales for select using (public.can_view_sale(id));
create policy sale_lines_select on public.sale_lines for select using (public.can_view_sale(sale_id));
create policy sale_line_costs_select on public.sale_line_costs for select using (public.can_view_costs(business_id, section_id));
create policy payments_select on public.payments for select using (public.can_view_sale(sale_id));

create policy expenses_select on public.expenses for select using (
  submitted_by = auth.uid()
  or public.is_owner(business_id)
  or (public.my_role(business_id) in ('section_owner','manager','accountant')
      and section_id is not null and public.has_section(business_id, section_id)));

create policy audit_select on public.audit_log for select using (
  public.is_owner(business_id) or (business_id is null and public.is_platform_admin()));

-- =====================================================================
-- Business setup & membership functions
-- =====================================================================
create or replace function public.create_business(
  p_name text, p_sections text[], p_phone text default null, p_address text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_b uuid; v_m uuid; s text;
begin
  if auth.uid() is null then raise exception 'Please sign in first'; end if;
  if coalesce(array_length(p_sections, 1), 0) = 0 then p_sections := array['Main']; end if;
  insert into businesses (name, phone, address, created_by) values (trim(p_name), p_phone, p_address, auth.uid())
    returning id into v_b;
  insert into memberships (business_id, user_id, role, all_sections, can_view_costs)
    values (v_b, auth.uid(), 'owner', true, true) returning id into v_m;
  foreach s in array p_sections loop
    if length(trim(s)) > 0 then
      insert into sections (business_id, name) values (v_b, trim(s)) on conflict do nothing;
    end if;
  end loop;
  insert into payment_methods (business_id, name, kind, sort) values
    (v_b, 'Cash', 'cash', 1), (v_b, 'MTN Mobile Money', 'mobile_money', 2), (v_b, 'Orange Money', 'mobile_money', 3);
  perform audit(v_b, 'business_created', 'business', v_b, jsonb_build_object('name', p_name));
  return v_b;
end $$;

create or replace function public.create_invitation(
  p_business uuid, p_email text, p_role text, p_all_sections boolean, p_section_ids uuid[], p_can_view_costs boolean)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_token uuid; v_id uuid;
begin
  if not is_owner(p_business) then raise exception 'Only a business owner can invite people'; end if;
  if p_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Enter a valid email address'; end if;
  if p_role not in ('owner','section_owner','manager','staff','accountant') then raise exception 'Unknown role'; end if;
  if exists (select 1 from unnest(coalesce(p_section_ids,'{}')) sid
             where not exists (select 1 from sections where id = sid and business_id = p_business)) then
    raise exception 'Section does not belong to this business';
  end if;
  insert into invitations (business_id, email, role, all_sections, section_ids, can_view_costs, invited_by)
  values (p_business, lower(trim(p_email)), p_role, p_role = 'owner' or coalesce(p_all_sections,false),
          coalesce(p_section_ids,'{}'), p_role <> 'staff' and coalesce(p_can_view_costs,false) or p_role = 'owner',
          auth.uid())
  returning id, token into v_id, v_token;
  perform audit(p_business, 'invitation_created', 'invitation', v_id,
                jsonb_build_object('email', lower(p_email), 'role', p_role));
  return v_token;
end $$;

create or replace function public.revoke_invitation(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v invitations;
begin
  select * into v from invitations where id = p_id;
  if not found or not is_owner(v.business_id) then raise exception 'Not allowed'; end if;
  update invitations set revoked_at = now() where id = p_id;
  perform audit(v.business_id, 'invitation_revoked', 'invitation', p_id, '{}');
end $$;

-- public lookup used by the invite page (token is the secret)
create or replace function public.get_invitation(p_token uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('business_name', b.name, 'email', i.email, 'role', i.role,
    'expired', i.expires_at < now(), 'accepted', i.accepted_at is not null, 'revoked', i.revoked_at is not null)
  from invitations i join businesses b on b.id = i.business_id where i.token = p_token
$$;

create or replace function public.accept_invitation(p_token uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare v invitations; v_email text; v_m uuid;
begin
  if auth.uid() is null then raise exception 'Please sign in first'; end if;
  select * into v from invitations where token = p_token for update;
  if not found or v.revoked_at is not null then raise exception 'This invitation is not valid'; end if;
  if v.accepted_at is not null then raise exception 'This invitation has already been used'; end if;
  if v.expires_at < now() then raise exception 'This invitation has expired. Ask the owner for a new one'; end if;
  select lower(email) into v_email from auth.users where id = auth.uid();
  if v_email is distinct from v.email then
    raise exception 'This invitation was sent to %. Sign in with that email address', v.email;
  end if;
  insert into memberships (business_id, user_id, role, all_sections, can_view_costs, active)
  values (v.business_id, auth.uid(), v.role, v.all_sections, v.can_view_costs, true)
  on conflict (business_id, user_id) do update
    set role = excluded.role, all_sections = excluded.all_sections,
        can_view_costs = excluded.can_view_costs, active = true
  returning id into v_m;
  delete from membership_sections where membership_id = v_m;
  insert into membership_sections (membership_id, section_id, business_id)
    select v_m, sid, v.business_id from unnest(v.section_ids) sid;
  update invitations set accepted_at = now() where id = v.id;
  perform audit(v.business_id, 'invitation_accepted', 'membership', v_m, jsonb_build_object('role', v.role));
  return v.business_id;
end $$;

create or replace function public.update_member(
  p_membership uuid, p_role text, p_all_sections boolean, p_section_ids uuid[], p_can_view_costs boolean, p_active boolean)
returns void language plpgsql security definer set search_path = public as $$
declare v memberships; v_after jsonb;
begin
  select * into v from memberships where id = p_membership for update;
  if not found or not is_owner(v.business_id) then raise exception 'Only a business owner can change roles'; end if;
  if v.role = 'owner' and (p_role <> 'owner' or not p_active)
     and (select count(*) from memberships where business_id = v.business_id and role = 'owner' and active) <= 1 then
    raise exception 'A business must keep at least one active owner';
  end if;
  if exists (select 1 from unnest(coalesce(p_section_ids,'{}')) sid
             where not exists (select 1 from sections where id = sid and business_id = v.business_id)) then
    raise exception 'Section does not belong to this business';
  end if;
  update memberships set role = p_role,
    all_sections = (p_role = 'owner' or coalesce(p_all_sections,false)),
    can_view_costs = (p_role = 'owner' or (p_role <> 'staff' and coalesce(p_can_view_costs,false))),
    active = p_active
  where id = p_membership;
  delete from membership_sections where membership_id = p_membership;
  insert into membership_sections (membership_id, section_id, business_id)
    select p_membership, sid, v.business_id from unnest(coalesce(p_section_ids,'{}')) sid;
  if not p_active then  -- lost device / leaver: close any open shift
    update shifts set ended_at = now(), closed_by = auth.uid(), note = coalesce(note,'') || ' [closed: access disabled]'
    where business_id = v.business_id and user_id = v.user_id and ended_at is null;
  end if;
  select to_jsonb(m) into v_after from memberships m where id = p_membership;
  perform audit(v.business_id, 'member_updated', 'membership', p_membership,
    jsonb_build_object('before', to_jsonb(v), 'after', v_after, 'sections', p_section_ids));
end $$;

-- =====================================================================
-- Shifts
-- =====================================================================
create or replace function public.clock_in(p_business uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not is_member(p_business) then raise exception 'You are not a member of this business'; end if;
  select id into v_id from shifts where business_id = p_business and user_id = auth.uid() and ended_at is null;
  if found then return v_id; end if;
  insert into shifts (business_id, user_id) values (p_business, auth.uid()) returning id into v_id;
  return v_id;
end $$;

-- staff close their own shift; owners/managers can close a forgotten shift
-- (optionally with a corrected end time) and it is audited.
create or replace function public.clock_out(p_shift uuid, p_note text default null, p_ended_at timestamptz default null)
returns void language plpgsql security definer set search_path = public as $$
declare v shifts; v_end timestamptz;
begin
  select * into v from shifts where id = p_shift for update;
  if not found then raise exception 'Shift not found'; end if;
  if v.ended_at is not null then raise exception 'This shift is already closed'; end if;
  v_end := coalesce(p_ended_at, now());
  if v_end < v.started_at or v_end > now() + interval '5 minutes' then raise exception 'Invalid end time'; end if;
  if v.user_id = auth.uid() and p_ended_at is null then
    update shifts set ended_at = v_end, note = p_note, closed_by = auth.uid() where id = p_shift;
  elsif my_role(v.business_id) in ('owner','section_owner','manager') then
    update shifts set ended_at = v_end, note = p_note, closed_by = auth.uid() where id = p_shift;
    perform audit(v.business_id, 'shift_closed_by_manager', 'shift', p_shift,
                  jsonb_build_object('staff', v.user_id, 'ended_at', v_end, 'note', p_note));
  else
    raise exception 'Only an owner or manager can close another person''s shift';
  end if;
end $$;

-- =====================================================================
-- Price override requests
-- =====================================================================
create or replace function public.request_price_override(
  p_business uuid, p_product uuid, p_price numeric, p_quantity int, p_reason text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_p products; v_id uuid;
begin
  select * into v_p from products where id = p_product and business_id = p_business;
  if not found then raise exception 'Product not found'; end if;
  if not has_section(p_business, v_p.section_id) then raise exception 'You are not assigned to this section'; end if;
  if p_price is null or p_price <= 0 then raise exception 'Enter a valid price'; end if;
  if p_price >= v_p.min_price then raise exception 'This price is allowed without approval'; end if;
  insert into price_override_requests (business_id, section_id, product_id, requested_by, requested_price, quantity, reason)
  values (p_business, v_p.section_id, p_product, auth.uid(), round(p_price, 2), greatest(coalesce(p_quantity,1),1), p_reason)
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.decide_price_override(
  p_request uuid, p_approve boolean, p_approved_price numeric default null, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v price_override_requests;
begin
  select * into v from price_override_requests where id = p_request for update;
  if not found then raise exception 'Request not found'; end if;
  if not can_approve(v.business_id, v.section_id) then
    raise exception 'Only the business owner or this section''s owner can approve price overrides';
  end if;
  if v.status <> 'pending' then raise exception 'This request was already %', v.status; end if;
  if p_approve then
    if coalesce(p_approved_price, v.requested_price) <= 0 then raise exception 'Enter a valid approved price'; end if;
    update price_override_requests set status = 'approved',
      approved_price = round(coalesce(p_approved_price, v.requested_price), 2),
      decided_by = auth.uid(), decided_at = now(), decision_note = p_note where id = p_request;
  else
    update price_override_requests set status = 'rejected', decided_by = auth.uid(), decided_at = now(),
      decision_note = p_note where id = p_request;
  end if;
  perform audit(v.business_id, case when p_approve then 'price_override_approved' else 'price_override_rejected' end,
    'price_override', p_request, jsonb_build_object('product', v.product_id, 'staff', v.requested_by,
      'requested', v.requested_price, 'approved', p_approved_price, 'note', p_note));
end $$;

create or replace function public.cancel_price_override(p_request uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  update price_override_requests set status = 'cancelled'
  where id = p_request and requested_by = auth.uid() and status in ('pending','approved');
end $$;

-- =====================================================================
-- SALES — the core atomic transaction
-- p = { business_id, client_tx_id, customer_name, customer_phone, note,
--       offline, sold_at,
--       lines:    [{product_id, quantity, unit_price, override_id}],
--       payments: [{method_id, amount, reference}] }
-- Online:  any violation raises an error and nothing is written.
-- Offline: stock/price/shift conflicts put the sale in 'pending_review'
--          (no stock moves) for an owner to accept or reject.
-- Retrying the same client_tx_id never creates a second sale.
-- =====================================================================
create or replace function public.finalize_sale(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid      uuid := auth.uid();
  v_b        uuid := (p->>'business_id')::uuid;
  v_tx       uuid := (p->>'client_tx_id')::uuid;
  v_offline  boolean := coalesce((p->>'offline')::boolean, false);
  v_sold_at  timestamptz;
  v_m        memberships;
  v_biz      businesses;
  v_ex       sales;
  v_shift    uuid;
  v_conf     text[] := '{}';
  v_line     jsonb;
  v_pay      jsonb;
  v_prod     products;
  v_ov       price_override_requests;
  v_qty      int;
  v_price    numeric(14,2);
  v_used     jsonb := '{}'::jsonb;
  v_total    numeric(14,2) := 0;
  v_paid     numeric(14,2) := 0;
  v_sale     uuid := gen_random_uuid();
  v_receipt  bigint;
  v_status   text;
  v_pstatus  text;
  v_line_id  uuid;
  v_cost     numeric(14,2);
  v_method   payment_methods;
  v_err      text;
begin
  if v_uid is null then raise exception 'Please sign in again'; end if;
  if v_tx is null then raise exception 'Missing transaction id'; end if;
  perform pg_advisory_xact_lock(hashtextextended(v_tx::text, 0));

  select * into v_ex from sales where client_tx_id = v_tx;
  if found then
    if v_ex.business_id <> v_b or v_ex.staff_user_id <> v_uid then raise exception 'Transaction id already used'; end if;
    return jsonb_build_object('sale_id', v_ex.id, 'receipt_no', v_ex.receipt_no, 'status', v_ex.status,
                              'conflicts', to_jsonb(v_ex.conflicts), 'duplicate', true);
  end if;

  select * into v_m from memberships where business_id = v_b and user_id = v_uid and active;
  if not found then raise exception 'Your access to this business is disabled'; end if;
  if v_m.role = 'accountant' then raise exception 'Read-only accounts cannot record sales'; end if;
  select * into v_biz from businesses where id = v_b;

  if jsonb_typeof(p->'lines') <> 'array' or jsonb_array_length(p->'lines') = 0 then
    raise exception 'The cart is empty';
  end if;
  if jsonb_array_length(p->'lines') > 200 then raise exception 'Too many lines in one sale'; end if;

  v_sold_at := now();
  if v_offline and p ? 'sold_at' then
    v_sold_at := least(now(), greatest((p->>'sold_at')::timestamptz, now() - interval '7 days'));
  end if;

  -- shift (the shift that covers the sale time)
  select id into v_shift from shifts
   where business_id = v_b and user_id = v_uid and started_at <= v_sold_at + interval '1 minute'
     and (ended_at is null or ended_at >= v_sold_at)
   order by started_at desc limit 1;
  if v_shift is null and v_biz.require_shift then
    if v_offline then v_conf := array_append(v_conf, 'No active shift when the sale was made');
    else raise exception 'Clock in before recording sales'; end if;
  end if;

  -- lock every product in this cart in a stable order (prevents deadlocks)
  perform 1 from products
   where id in (select (l->>'product_id')::uuid from jsonb_array_elements(p->'lines') l)
   order by id for update;

  -- pass 1: validate
  for v_line in select * from jsonb_array_elements(p->'lines') loop
    v_qty := (v_line->>'quantity')::int;
    v_price := round((v_line->>'unit_price')::numeric, 2);
    select * into v_prod from products where id = (v_line->>'product_id')::uuid and business_id = v_b;
    if not found then raise exception 'A product in the cart no longer exists'; end if;
    if v_qty is null or v_qty <= 0 then raise exception 'Invalid quantity for %', v_prod.name; end if;
    if v_price is null or v_price <= 0 then raise exception 'Invalid price for %', v_prod.name; end if;
    if not has_section(v_b, v_prod.section_id) then
      raise exception 'You are not assigned to the section that sells %', v_prod.name;
    end if;

    v_err := null;
    if not v_prod.active then v_err := format('%s is no longer active', v_prod.name); end if;
    v_used := jsonb_set(v_used, array[v_prod.id::text], to_jsonb(coalesce((v_used->>v_prod.id::text)::int, 0) + v_qty));
    if v_err is null and (v_used->>v_prod.id::text)::int > v_prod.stock_qty then
      v_err := format('Only %s of %s left in stock', v_prod.stock_qty, v_prod.name);
    end if;
    if v_err is null and v_price < v_prod.min_price then
      if v_line->>'override_id' is null then
        v_err := format('%s: price %s is below the minimum %s. Owner approval is required', v_prod.name, v_price, v_prod.min_price);
      else
        select * into v_ov from price_override_requests where id = (v_line->>'override_id')::uuid for update;
        if not found or v_ov.business_id <> v_b or v_ov.product_id <> v_prod.id or v_ov.requested_by <> v_uid then
          v_err := format('%s: invalid price approval', v_prod.name);
        elsif v_ov.status <> 'approved' then
          v_err := format('%s: price approval is %s', v_prod.name, v_ov.status);
        elsif v_ov.approved_price <> v_price then
          v_err := format('%s: approved price is %s, not %s', v_prod.name, v_ov.approved_price, v_price);
        elsif v_qty > v_ov.quantity then
          v_err := format('%s: approval covers only %s unit(s)', v_prod.name, v_ov.quantity);
        end if;
      end if;
    end if;
    if v_err is not null then
      if v_offline then v_conf := array_append(v_conf, v_err); else raise exception '%', v_err; end if;
    end if;
    v_total := v_total + v_price * v_qty;
  end loop;

  -- payments
  if p->'payments' is not null and jsonb_typeof(p->'payments') = 'array' then
    for v_pay in select * from jsonb_array_elements(p->'payments') loop
      if round((v_pay->>'amount')::numeric, 2) <= 0 then raise exception 'Each payment must be more than zero'; end if;
      select * into v_method from payment_methods where id = (v_pay->>'method_id')::uuid and business_id = v_b and active;
      if not found then raise exception 'Unknown payment method'; end if;
      v_paid := v_paid + round((v_pay->>'amount')::numeric, 2);
    end loop;
  end if;
  if v_paid > v_total then
    raise exception 'Payments (%) are more than the sale total (%). Enter the amount kept, not the cash handed over', v_paid, v_total;
  end if;

  v_status := case when coalesce(array_length(v_conf, 1), 0) > 0 then 'pending_review' else 'completed' end;
  v_pstatus := case when v_paid = 0 then 'unpaid' when v_paid < v_total then 'partial' else 'paid' end;

  update businesses set receipt_seq = receipt_seq + 1 where id = v_b returning receipt_seq into v_receipt;

  insert into sales (id, business_id, receipt_no, client_tx_id, staff_user_id, shift_id, no_shift,
                     customer_name, customer_phone, total, amount_paid, balance_due, payment_status, status,
                     conflicts, offline, note, sold_at)
  values (v_sale, v_b, v_receipt, v_tx, v_uid, v_shift, v_shift is null,
          nullif(trim(p->>'customer_name'), ''), nullif(trim(p->>'customer_phone'), ''),
          v_total, v_paid, v_total - v_paid, v_pstatus, v_status, v_conf, v_offline, p->>'note', v_sold_at);

  -- pass 2: write lines (+ stock & cost if completed)
  for v_line in select * from jsonb_array_elements(p->'lines') loop
    v_qty := (v_line->>'quantity')::int;
    v_price := round((v_line->>'unit_price')::numeric, 2);
    select * into v_prod from products where id = (v_line->>'product_id')::uuid;
    insert into sale_lines (sale_id, business_id, section_id, product_id, product_name, quantity,
                            target_price, min_price, unit_price, line_total, override_id)
    values (v_sale, v_b, v_prod.section_id, v_prod.id,
            v_prod.name || coalesce(' (' || v_prod.variant_label || ')', ''), v_qty,
            v_prod.target_price, v_prod.min_price, v_price, v_price * v_qty,
            case when v_price < v_prod.min_price then (v_line->>'override_id')::uuid end)
    returning id into v_line_id;

    if v_status = 'completed' then
      select avg_cost into v_cost from product_costs where product_id = v_prod.id;
      insert into sale_line_costs (sale_line_id, business_id, section_id, unit_cost, cost_total)
      values (v_line_id, v_b, v_prod.section_id, coalesce(v_cost, 0), coalesce(v_cost, 0) * v_qty);
      update products set stock_qty = stock_qty - v_qty where id = v_prod.id;
      insert into stock_movements (business_id, section_id, product_id, kind, qty_change, balance_after,
                                   ref_type, ref_id, created_by)
      values (v_b, v_prod.section_id, v_prod.id, 'sale', -v_qty, v_prod.stock_qty - v_qty, 'sale', v_sale, v_uid);
      if v_price < v_prod.min_price then
        update price_override_requests set status = 'used', sale_id = v_sale where id = (v_line->>'override_id')::uuid;
        perform audit(v_b, 'price_override_used', 'sale', v_sale,
          jsonb_build_object('product', v_prod.id, 'price', v_price, 'min', v_prod.min_price,
                             'override', v_line->>'override_id'));
      end if;
    end if;
  end loop;

  if p->'payments' is not null and jsonb_typeof(p->'payments') = 'array' then
    for v_pay in select * from jsonb_array_elements(p->'payments') loop
      select * into v_method from payment_methods where id = (v_pay->>'method_id')::uuid;
      insert into payments (sale_id, business_id, method_id, method_name, amount, reference, received_by, created_at)
      values (v_sale, v_b, v_method.id, v_method.name, round((v_pay->>'amount')::numeric, 2),
              nullif(trim(v_pay->>'reference'), ''), v_uid, v_sold_at);
    end loop;
  end if;

  if v_status = 'pending_review' then
    perform audit(v_b, 'offline_sale_conflict', 'sale', v_sale, jsonb_build_object('conflicts', v_conf));
  elsif v_shift is null then
    perform audit(v_b, 'sale_without_shift', 'sale', v_sale, '{}');
  end if;

  return jsonb_build_object('sale_id', v_sale, 'receipt_no', v_receipt, 'status', v_status,
                            'conflicts', to_jsonb(v_conf), 'total', v_total, 'paid', v_paid,
                            'balance', v_total - v_paid, 'duplicate', false);
end $$;

-- record a later payment against an outstanding balance
create or replace function public.add_payment(p_sale uuid, p_method uuid, p_amount numeric, p_reference text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v sales; v_method payment_methods; v_amt numeric(14,2) := round(p_amount, 2);
begin
  select * into v from sales where id = p_sale for update;
  if not found or not can_view_sale(p_sale) then raise exception 'Sale not found'; end if;
  if my_role(v.business_id) = 'accountant' then raise exception 'Read-only accounts cannot record payments'; end if;
  if v.status not in ('completed','pending_review') then raise exception 'This sale is %', v.status; end if;
  if v_amt is null or v_amt <= 0 then raise exception 'Enter an amount'; end if;
  if v_amt > v.balance_due then raise exception 'Amount is more than the balance due (%)', v.balance_due; end if;
  select * into v_method from payment_methods where id = p_method and business_id = v.business_id and active;
  if not found then raise exception 'Unknown payment method'; end if;
  insert into payments (sale_id, business_id, method_id, method_name, amount, reference, received_by)
  values (p_sale, v.business_id, p_method, v_method.name, v_amt, nullif(trim(p_reference),''), auth.uid());
  update sales set amount_paid = amount_paid + v_amt, balance_due = balance_due - v_amt,
    payment_status = case when balance_due - v_amt = 0 then 'paid' else 'partial' end
  where id = p_sale;
end $$;

-- void reverses stock and removes the sale from revenue (audited)
create or replace function public.void_sale(p_sale uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare v sales; l record; v_bal int;
begin
  select * into v from sales where id = p_sale for update;
  if not found then raise exception 'Sale not found'; end if;
  if exists (select 1 from sale_lines where sale_id = p_sale and not can_approve(v.business_id, section_id)) then
    raise exception 'Only the owner (or the owner of every section in this sale) can void it';
  end if;
  if v.status <> 'completed' then raise exception 'Only completed sales can be voided'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'Give a reason for voiding'; end if;
  for l in select * from sale_lines where sale_id = p_sale order by product_id loop
    update products set stock_qty = stock_qty + l.quantity where id = l.product_id returning stock_qty into v_bal;
    insert into stock_movements (business_id, section_id, product_id, kind, qty_change, balance_after, ref_type, ref_id, reason, created_by)
    values (v.business_id, l.section_id, l.product_id, 'void', l.quantity, v_bal, 'sale', p_sale, p_reason, auth.uid());
  end loop;
  update sales set status = 'voided', payment_status = 'voided', decided_by = auth.uid(), decided_at = now(),
    decision_reason = p_reason where id = p_sale;
  perform audit(v.business_id, 'sale_voided', 'sale', p_sale,
    jsonb_build_object('receipt_no', v.receipt_no, 'total', v.total, 'paid', v.amount_paid, 'reason', p_reason));
end $$;

-- owner decision on an offline sale that hit a conflict
create or replace function public.resolve_sale_review(p_sale uuid, p_accept boolean, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v sales; l record; v_prod products; v_cost numeric(14,2);
begin
  select * into v from sales where id = p_sale for update;
  if not found then raise exception 'Sale not found'; end if;
  if exists (select 1 from sale_lines where sale_id = p_sale and not can_approve(v.business_id, section_id)) then
    raise exception 'Only the owner (or the section owner) can resolve this sale';
  end if;
  if v.status <> 'pending_review' then raise exception 'This sale is not waiting for review'; end if;
  if p_accept then
    perform 1 from products where id in (select product_id from sale_lines where sale_id = p_sale) order by id for update;
    for l in select product_id, sum(quantity) q, min(product_name) n from sale_lines where sale_id = p_sale group by product_id loop
      select * into v_prod from products where id = l.product_id;
      if v_prod.stock_qty < l.q then
        raise exception 'Only % of % in stock. Correct the stock count first, or reject this sale', v_prod.stock_qty, l.n;
      end if;
    end loop;
    for l in select * from sale_lines where sale_id = p_sale loop
      select avg_cost into v_cost from product_costs where product_id = l.product_id;
      insert into sale_line_costs (sale_line_id, business_id, section_id, unit_cost, cost_total)
      values (l.id, v.business_id, l.section_id, coalesce(v_cost,0), coalesce(v_cost,0) * l.quantity);
      update products set stock_qty = stock_qty - l.quantity where id = l.product_id returning * into v_prod;
      insert into stock_movements (business_id, section_id, product_id, kind, qty_change, balance_after, ref_type, ref_id, reason, created_by)
      values (v.business_id, l.section_id, l.product_id, 'sale', -l.quantity, v_prod.stock_qty, 'sale', p_sale,
              'offline sale accepted after review', auth.uid());
    end loop;
    update sales set status = 'completed', decided_by = auth.uid(), decided_at = now(), decision_reason = p_reason where id = p_sale;
  else
    update sales set status = 'rejected', payment_status = 'refunded', decided_by = auth.uid(), decided_at = now(),
      decision_reason = p_reason where id = p_sale;
  end if;
  perform audit(v.business_id, case when p_accept then 'offline_sale_accepted' else 'offline_sale_rejected' end,
                'sale', p_sale, jsonb_build_object('reason', p_reason, 'conflicts', v.conflicts));
end $$;

-- =====================================================================
-- Stock & purchasing
-- =====================================================================
create or replace function public.apply_wac(p_product uuid, p_qty int, p_unit_cost numeric) returns void
language plpgsql security definer set search_path = public as $$
declare v_old_qty int; v_old numeric(14,2);
begin
  -- called after locking; stock_qty is the balance BEFORE this receipt
  select greatest(stock_qty, 0) into v_old_qty from products where id = p_product;
  select avg_cost into v_old from product_costs where product_id = p_product;
  update product_costs set
    avg_cost = case when v_old_qty + p_qty <= 0 then p_unit_cost
                    else round((v_old_qty * coalesce(v_old,0) + p_qty * p_unit_cost) / (v_old_qty + p_qty), 2) end,
    updated_at = now()
  where product_id = p_product;
end $$;
revoke all on function public.apply_wac(uuid, int, numeric) from public, anon, authenticated;

create or replace function public.adjust_stock(
  p_product uuid, p_qty_change int, p_kind text, p_reason text, p_unit_cost numeric default null)
returns int language plpgsql security definer set search_path = public as $$
declare v products; v_new int;
begin
  select * into v from products where id = p_product for update;
  if not found then raise exception 'Product not found'; end if;
  if not can_manage(v.business_id, v.section_id) then
    raise exception 'Only an owner or manager of this section can change stock';
  end if;
  if p_kind not in ('opening','adjustment','damage','return') then raise exception 'Unknown adjustment type'; end if;
  if p_qty_change is null or p_qty_change = 0 then raise exception 'Enter a quantity'; end if;
  if p_kind = 'damage' and p_qty_change > 0 then p_qty_change := -p_qty_change; end if;
  if p_kind in ('opening','return') and p_qty_change < 0 then raise exception 'Use an adjustment to reduce stock'; end if;
  if coalesce(trim(p_reason), '') = '' and p_kind <> 'opening' then raise exception 'Give a reason'; end if;
  v_new := v.stock_qty + p_qty_change;
  if v_new < 0 then raise exception 'Stock cannot go below zero (currently %)', v.stock_qty; end if;
  if p_qty_change > 0 and p_unit_cost is not null then
    if not can_view_costs(v.business_id, v.section_id) then raise exception 'You cannot set cost prices'; end if;
    if p_unit_cost < 0 then raise exception 'Invalid cost'; end if;
    perform apply_wac(p_product, p_qty_change, round(p_unit_cost, 2));
  end if;
  update products set stock_qty = v_new where id = p_product;
  insert into stock_movements (business_id, section_id, product_id, kind, qty_change, balance_after, reason, created_by)
  values (v.business_id, v.section_id, p_product, p_kind, p_qty_change, v_new, p_reason, auth.uid());
  perform audit(v.business_id, 'stock_' || p_kind, 'product', p_product,
    jsonb_build_object('change', p_qty_change, 'before', v.stock_qty, 'after', v_new, 'reason', p_reason, 'unit_cost', p_unit_cost));
  return v_new;
end $$;

create or replace function public.set_product_cost(p_product uuid, p_cost numeric) returns void
language plpgsql security definer set search_path = public as $$
declare v products; v_old numeric;
begin
  select * into v from products where id = p_product;
  if not found or not can_view_costs(v.business_id, v.section_id) then raise exception 'Not allowed'; end if;
  if p_cost is null or p_cost < 0 then raise exception 'Invalid cost'; end if;
  select avg_cost into v_old from product_costs where product_id = p_product;
  update product_costs set avg_cost = round(p_cost, 2), updated_at = now() where product_id = p_product;
  perform audit(v.business_id, 'cost_price_set', 'product', p_product, jsonb_build_object('before', v_old, 'after', p_cost));
end $$;

-- p = { business_id, section_id, supplier_id | supplier_name, source, currency, exchange_rate,
--       purchase_date, freight_cost, other_costs, allocation_method, reference, notes,
--       lines: [{product_id, quantity, unit_price}] }     unit_price in purchase currency;
--       freight/other costs in the business currency.
create or replace function public.receive_purchase(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_b uuid := (p->>'business_id')::uuid;
  v_s uuid := (p->>'section_id')::uuid;
  v_rate numeric := coalesce(nullif(p->>'exchange_rate','')::numeric, 1);
  v_extra numeric(14,2) := coalesce(nullif(p->>'freight_cost','')::numeric, 0) + coalesce(nullif(p->>'other_costs','')::numeric, 0);
  v_method text := coalesce(p->>'allocation_method', 'value');
  v_supplier uuid := nullif(p->>'supplier_id','')::uuid;
  v_purchase uuid;
  v_total_value numeric := 0; v_total_qty int := 0;
  v_line jsonb; v_prod products; v_qty int; v_unit_local numeric(14,2);
  v_alloc numeric(14,2); v_alloc_sum numeric(14,2) := 0; v_landed numeric(14,2);
  v_n int; v_i int := 0;
begin
  if not (can_manage(v_b, v_s) and can_view_costs(v_b, v_s)) then
    raise exception 'Only owners, or managers with financial access, can receive purchases for this section';
  end if;
  if jsonb_typeof(p->'lines') <> 'array' or jsonb_array_length(p->'lines') = 0 then raise exception 'Add at least one item'; end if;
  if v_rate <= 0 then raise exception 'Invalid exchange rate'; end if;
  if v_method not in ('value','quantity') then raise exception 'Unknown allocation method'; end if;
  v_n := jsonb_array_length(p->'lines');

  if v_supplier is null and coalesce(trim(p->>'supplier_name'),'') <> '' then
    insert into suppliers (business_id, name, country) values (v_b, trim(p->>'supplier_name'), p->>'supplier_country')
    on conflict (business_id, name) do update set name = excluded.name returning id into v_supplier;
  end if;
  if v_supplier is not null and not exists (select 1 from suppliers where id = v_supplier and business_id = v_b) then
    raise exception 'Unknown supplier';
  end if;

  perform 1 from products where id in (select (l->>'product_id')::uuid from jsonb_array_elements(p->'lines') l) order by id for update;
  for v_line in select * from jsonb_array_elements(p->'lines') loop
    select * into v_prod from products where id = (v_line->>'product_id')::uuid and business_id = v_b;
    if not found then raise exception 'Unknown product in purchase'; end if;
    if v_prod.section_id <> v_s then raise exception '% belongs to another section', v_prod.name; end if;
    if (v_line->>'quantity')::int <= 0 then raise exception 'Invalid quantity for %', v_prod.name; end if;
    if (v_line->>'unit_price')::numeric < 0 then raise exception 'Invalid price for %', v_prod.name; end if;
    v_total_qty := v_total_qty + (v_line->>'quantity')::int;
    v_total_value := v_total_value + (v_line->>'quantity')::int * round((v_line->>'unit_price')::numeric * v_rate, 2);
  end loop;

  insert into purchases (business_id, section_id, supplier_id, source, currency, exchange_rate, purchase_date,
                         freight_cost, other_costs, allocation_method, reference, notes, created_by)
  values (v_b, v_s, v_supplier, coalesce(p->>'source','local'), coalesce(p->>'currency','XAF'), v_rate,
          coalesce(nullif(p->>'purchase_date','')::date, current_date),
          coalesce(nullif(p->>'freight_cost','')::numeric, 0), coalesce(nullif(p->>'other_costs','')::numeric, 0),
          v_method, p->>'reference', p->>'notes', auth.uid())
  returning id into v_purchase;

  for v_line in select * from jsonb_array_elements(p->'lines') loop
    v_i := v_i + 1;
    v_qty := (v_line->>'quantity')::int;
    v_unit_local := round((v_line->>'unit_price')::numeric * v_rate, 2);
    if v_i = v_n then
      v_alloc := v_extra - v_alloc_sum;           -- remainder to the last line: totals stay exact
    elsif v_method = 'quantity' or v_total_value = 0 then
      v_alloc := round(v_extra * v_qty / v_total_qty, 2);
    else
      v_alloc := round(v_extra * (v_qty * v_unit_local) / v_total_value, 2);
    end if;
    v_alloc_sum := v_alloc_sum + v_alloc;
    v_landed := round((v_qty * v_unit_local + v_alloc) / v_qty, 2);
    select * into v_prod from products where id = (v_line->>'product_id')::uuid;

    insert into purchase_lines (purchase_id, business_id, product_id, quantity, unit_price, unit_price_local,
                                allocated_extra, landed_unit_cost)
    values (v_purchase, v_b, v_prod.id, v_qty, round((v_line->>'unit_price')::numeric, 2), v_unit_local, v_alloc, v_landed);

    perform apply_wac(v_prod.id, v_qty, v_landed);
    update products set stock_qty = stock_qty + v_qty where id = v_prod.id;
    insert into stock_movements (business_id, section_id, product_id, kind, qty_change, balance_after, ref_type, ref_id, created_by)
    values (v_b, v_s, v_prod.id, 'purchase', v_qty, v_prod.stock_qty + v_qty, 'purchase', v_purchase, auth.uid());
  end loop;

  perform audit(v_b, 'purchase_received', 'purchase', v_purchase,
    jsonb_build_object('lines', v_n, 'extra_costs', v_extra, 'method', v_method));
  return v_purchase;
end $$;

create or replace function public.flag_stock(p_product uuid, p_kind text, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare v products;
begin
  select * into v from products where id = p_product;
  if not found or not is_member(v.business_id) then raise exception 'Product not found'; end if;
  if p_kind not in ('low','arrived') then raise exception 'Unknown flag'; end if;
  insert into stock_flags (business_id, product_id, kind, note, created_by) values (v.business_id, p_product, p_kind, p_note, auth.uid());
end $$;

create or replace function public.resolve_stock_flag(p_flag uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v stock_flags;
begin
  select * into v from stock_flags where id = p_flag;
  if not found or my_role(v.business_id) not in ('owner','section_owner','manager') then raise exception 'Not allowed'; end if;
  update stock_flags set resolved_by = auth.uid(), resolved_at = now() where id = p_flag;
end $$;

-- Bulk import. Validates every row first; writes nothing if any row is invalid.
-- rows: [{section, category, name, brand, model, sku, variant_label, description,
--         target_price, min_price, low_stock_threshold, opening_stock, unit_cost}]
-- p_mode: 'skip' (keep existing SKUs) or 'update' (update prices/details of existing SKUs)
create or replace function public.import_products(p_business uuid, p_rows jsonb, p_mode text default 'skip')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r jsonb; i int := 0; v_errors jsonb := '[]'::jsonb;
  v_section uuid; v_cat uuid; v_existing products; v_id uuid;
  v_ins int := 0; v_upd int := 0; v_skip int := 0;
  v_target numeric; v_min numeric; v_open int; v_cost numeric;
  v_seen text[] := '{}';
begin
  if my_role(p_business) not in ('owner','section_owner','manager') then raise exception 'Not allowed to import products'; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then raise exception 'No rows to import'; end if;
  if jsonb_array_length(p_rows) > 5000 then raise exception 'Import at most 5000 rows at a time'; end if;

  -- validation pass
  for r in select * from jsonb_array_elements(p_rows) loop
    i := i + 1;
    select id into v_section from sections where business_id = p_business and lower(name) = lower(trim(r->>'section'));
    begin
      v_target := nullif(r->>'target_price','')::numeric;
      v_min := coalesce(nullif(r->>'min_price','')::numeric, v_target);
      v_open := coalesce(nullif(r->>'opening_stock','')::numeric::int, 0);
      v_cost := nullif(r->>'unit_cost','')::numeric;
    exception when others then
      v_errors := v_errors || jsonb_build_object('row', i, 'message', 'A number column contains text'); continue;
    end;
    if coalesce(trim(r->>'name'),'') = '' then
      v_errors := v_errors || jsonb_build_object('row', i, 'message', 'Name is required');
    elsif v_section is null then
      v_errors := v_errors || jsonb_build_object('row', i, 'message', format('Unknown section "%s"', r->>'section'));
    elsif not can_manage(p_business, v_section) then
      v_errors := v_errors || jsonb_build_object('row', i, 'message', 'You cannot manage this section');
    elsif v_target is null or v_target <= 0 then
      v_errors := v_errors || jsonb_build_object('row', i, 'message', 'Target price must be more than 0');
    elsif v_min <= 0 or v_min > v_target then
      v_errors := v_errors || jsonb_build_object('row', i, 'message', 'Minimum price must be between 1 and the target price');
    elsif v_open < 0 then
      v_errors := v_errors || jsonb_build_object('row', i, 'message', 'Opening stock cannot be negative');
    elsif v_cost is not null and v_cost < 0 then
      v_errors := v_errors || jsonb_build_object('row', i, 'message', 'Cost cannot be negative');
    elsif coalesce(trim(r->>'sku'),'') <> '' and lower(trim(r->>'sku')) = any(v_seen) then
      v_errors := v_errors || jsonb_build_object('row', i, 'message', format('SKU "%s" appears twice in the file', r->>'sku'));
    end if;
    if coalesce(trim(r->>'sku'),'') <> '' then v_seen := v_seen || lower(trim(r->>'sku')); end if;
  end loop;
  if jsonb_array_length(v_errors) > 0 then
    return jsonb_build_object('ok', false, 'errors', v_errors);
  end if;

  -- write pass
  for r in select * from jsonb_array_elements(p_rows) loop
    select id into v_section from sections where business_id = p_business and lower(name) = lower(trim(r->>'section'));
    v_cat := null;
    if coalesce(trim(r->>'category'),'') <> '' then
      insert into categories (business_id, name) values (p_business, trim(r->>'category'))
      on conflict (business_id, name) do update set name = excluded.name returning id into v_cat;
    end if;
    v_target := (r->>'target_price')::numeric;
    v_min := coalesce(nullif(r->>'min_price','')::numeric, v_target);
    v_open := coalesce(nullif(r->>'opening_stock','')::numeric::int, 0);
    v_cost := nullif(r->>'unit_cost','')::numeric;
    v_existing := null;
    if coalesce(trim(r->>'sku'),'') <> '' then
      select * into v_existing from products where business_id = p_business and lower(sku) = lower(trim(r->>'sku'));
    end if;
    if v_existing.id is not null then
      if p_mode = 'update' then
        update products set name = trim(r->>'name'), brand = nullif(r->>'brand',''), model = nullif(r->>'model',''),
          category_id = coalesce(v_cat, category_id), target_price = v_target, min_price = v_min,
          variant_label = nullif(r->>'variant_label',''), description = coalesce(nullif(r->>'description',''), description),
          low_stock_threshold = coalesce(nullif(r->>'low_stock_threshold','')::int, low_stock_threshold)
        where id = v_existing.id;
        v_upd := v_upd + 1;
      else
        v_skip := v_skip + 1;
      end if;
      continue;
    end if;
    insert into products (business_id, section_id, category_id, name, brand, model, sku, variant_label, description,
                          target_price, min_price, low_stock_threshold)
    values (p_business, v_section, v_cat, trim(r->>'name'), nullif(r->>'brand',''), nullif(r->>'model',''),
            nullif(trim(r->>'sku'),''), nullif(r->>'variant_label',''), nullif(r->>'description',''),
            v_target, v_min, coalesce(nullif(r->>'low_stock_threshold','')::int, 3))
    returning id into v_id;
    if v_cost is not null and can_view_costs(p_business, v_section) then
      update product_costs set avg_cost = round(v_cost, 2) where product_id = v_id;
    end if;
    if v_open > 0 then
      update products set stock_qty = v_open where id = v_id;
      insert into stock_movements (business_id, section_id, product_id, kind, qty_change, balance_after, reason, created_by)
      values (p_business, v_section, v_id, 'opening', v_open, v_open, 'bulk import', auth.uid());
    end if;
    v_ins := v_ins + 1;
  end loop;
  perform audit(p_business, 'products_imported', 'business', p_business,
                jsonb_build_object('inserted', v_ins, 'updated', v_upd, 'skipped', v_skip));
  return jsonb_build_object('ok', true, 'inserted', v_ins, 'updated', v_upd, 'skipped', v_skip);
end $$;

-- =====================================================================
-- Expenses
-- =====================================================================
create or replace function public.submit_expense(
  p_business uuid, p_section uuid, p_category text, p_amount numeric, p_date date,
  p_description text, p_payment_method text default null, p_attachment_url text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_auto boolean;
begin
  if not is_member(p_business) or my_role(p_business) = 'accountant' then raise exception 'Not allowed'; end if;
  if p_section is not null and not exists (select 1 from sections where id = p_section and business_id = p_business) then
    raise exception 'Unknown section';
  end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Enter an amount'; end if;
  if coalesce(trim(p_category),'') = '' then raise exception 'Choose a category'; end if;
  v_auto := can_approve_expense(p_business, p_section);
  insert into expenses (business_id, section_id, category, amount, expense_date, description, payment_method,
                        attachment_url, status, submitted_by, decided_by, decided_at)
  values (p_business, p_section, trim(p_category), round(p_amount,2), coalesce(p_date, current_date), p_description,
          p_payment_method, p_attachment_url, case when v_auto then 'approved' else 'pending' end, auth.uid(),
          case when v_auto then auth.uid() end, case when v_auto then now() end)
  returning id into v_id;
  if v_auto then
    perform audit(p_business, 'expense_approved', 'expense', v_id, jsonb_build_object('amount', p_amount, 'self_recorded', true));
  end if;
  return v_id;
end $$;

create or replace function public.decide_expense(p_expense uuid, p_approve boolean, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v expenses;
begin
  select * into v from expenses where id = p_expense for update;
  if not found then raise exception 'Expense not found'; end if;
  if not can_approve_expense(v.business_id, v.section_id) then raise exception 'You cannot approve this expense'; end if;
  if v.status <> 'pending' then raise exception 'This expense was already %', v.status; end if;
  update expenses set status = case when p_approve then 'approved' else 'rejected' end,
    decided_by = auth.uid(), decided_at = now(), decision_note = p_note where id = p_expense;
  perform audit(v.business_id, case when p_approve then 'expense_approved' else 'expense_rejected' end,
                'expense', p_expense, jsonb_build_object('amount', v.amount, 'note', p_note));
end $$;

-- =====================================================================
-- Reports (role-aware). Dates are in the business timezone.
-- Owners/partners/managers/accountants: their permitted sections.
-- Staff: only their own sales, never costs.
-- =====================================================================
create or replace function public.report_summary(p_business uuid, p_from date, p_to date, p_section uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_role text := my_role(p_business);
  v_tz text;
  v_staff_only boolean;
  v_costs boolean;
  v_from timestamptz; v_to timestamptz;
  v_res jsonb;
begin
  if v_role is null then raise exception 'Not a member of this business'; end if;
  select timezone into v_tz from businesses where id = p_business;
  v_from := (p_from::timestamp) at time zone v_tz;
  v_to := ((p_to + 1)::timestamp) at time zone v_tz;
  v_staff_only := v_role = 'staff';
  v_costs := not v_staff_only and (v_role = 'owner' or
             (select can_view_costs from memberships where business_id = p_business and user_id = auth.uid()));

  with sl as (
    select s.id sale_id, s.staff_user_id, s.shift_id, s.total, s.amount_paid, s.balance_due, s.sold_at,
           l.section_id, l.product_id, l.product_name, l.quantity, l.line_total,
           case when v_costs then c.cost_total end cost_total
    from sales s
    join sale_lines l on l.sale_id = s.id
    left join sale_line_costs c on c.sale_line_id = l.id
    where s.business_id = p_business and s.status = 'completed'
      and s.sold_at >= v_from and s.sold_at < v_to
      and (p_section is null or l.section_id = p_section)
      and (case when v_staff_only then s.staff_user_id = auth.uid() else can_report(p_business, l.section_id) end)
  ),
  per_sale as (   -- the share of each sale that falls inside the scope (for payment allocation)
    select sale_id, max(total) total, max(amount_paid) paid, max(balance_due) bal, sum(line_total) scoped
    from sl group by sale_id
  ),
  pays as (
    select p.method_name, sum(p.amount * ps.scoped / nullif(ps.total, 0)) amt
    from payments p join per_sale ps on ps.sale_id = p.sale_id
    group by p.method_name
  ),
  exp as (
    select coalesce(sum(amount) filter (where status = 'approved'), 0) approved,
           coalesce(sum(amount) filter (where status = 'pending'), 0) pending
    from expenses e
    where e.business_id = p_business and e.expense_date between p_from and p_to and not v_staff_only
      and (case when p_section is not null then e.section_id = p_section
                when e.section_id is null then has_section(p_business, null)
                else can_report(p_business, e.section_id) end)
  ),
  tot as (
    select coalesce(sum(line_total), 0) revenue, coalesce(sum(cost_total), 0) cogs,
           count(distinct sale_id) sales_count, coalesce(sum(quantity), 0) units
    from sl
  )
  select jsonb_build_object(
    'scope', case when v_staff_only then 'own' else 'business' end,
    'costs_visible', v_costs,
    'currency', (select currency from businesses where id = p_business),
    'gross_revenue', t.revenue,
    'sales_count', t.sales_count,
    'units', t.units,
    'collected', coalesce((select round(sum(amt), 2) from pays), 0),
    'outstanding', coalesce((select round(sum(bal * scoped / nullif(total, 0)), 2) from per_sale), 0),
    'cogs', case when v_costs then t.cogs end,
    'gross_profit', case when v_costs then t.revenue - t.cogs end,
    'approved_expenses', case when v_staff_only then null else e.approved end,
    'pending_expenses', case when v_staff_only then null else e.pending end,
    'net_result', case when v_costs then t.revenue - t.cogs - e.approved end,
    'by_day', coalesce((select jsonb_agg(d order by d.day) from (
        select (sold_at at time zone v_tz)::date as day, sum(line_total) as revenue, count(distinct sale_id) sales,
               case when v_costs then sum(line_total) - sum(cost_total) end profit
        from sl group by 1) d), '[]'),
    'by_product', coalesce((select jsonb_agg(x order by x.revenue desc) from (
        select product_id, min(product_name) name, sum(quantity) units, sum(line_total) revenue,
               case when v_costs then sum(line_total) - sum(cost_total) end profit
        from sl group by product_id order by sum(line_total) desc limit 25) x), '[]'),
    'by_staff', coalesce((select jsonb_agg(x order by x.revenue desc) from (
        select sl.staff_user_id user_id, coalesce(pr.full_name, pr.email) name, count(distinct sale_id) sales,
               sum(line_total) revenue
        from sl left join profiles pr on pr.user_id = sl.staff_user_id group by 1, 2) x), '[]'),
    'by_shift', coalesce((select jsonb_agg(x order by x.started_at desc) from (
        select sh.id, coalesce(pr.full_name, pr.email) name, sh.started_at, sh.ended_at,
               count(distinct sl.sale_id) sales, sum(sl.line_total) revenue
        from sl join shifts sh on sh.id = sl.shift_id left join profiles pr on pr.user_id = sh.user_id
        group by 1, 2, 3, 4 order by sh.started_at desc limit 30) x), '[]'),
    'by_method', coalesce((select jsonb_agg(jsonb_build_object('method', method_name, 'amount', round(amt, 2))) from pays), '[]'),
    'by_section', coalesce((select jsonb_agg(x order by x.revenue desc) from (
        select sl.section_id, sec.name, sum(line_total) revenue,
               case when v_costs then sum(line_total) - sum(cost_total) end profit
        from sl join sections sec on sec.id = sl.section_id group by 1, 2) x), '[]')
  ) into v_res
  from tot t, exp e;
  return v_res;
end $$;

-- =====================================================================
-- Brand (platform administrator)
-- =====================================================================
create or replace function public.update_brand(
  p_product_name text, p_tagline text, p_logo_url text, p_icon_url text, p_primary_color text,
  p_support_email text, p_support_phone text)
returns void language plpgsql security definer set search_path = public as $$
declare v_before jsonb;
begin
  if not is_platform_admin() then raise exception 'Only a platform administrator can change branding'; end if;
  if coalesce(trim(p_product_name),'') = '' then raise exception 'Product name is required'; end if;
  select to_jsonb(b) into v_before from brand_config b where id = 1;
  update brand_config set product_name = trim(p_product_name), tagline = coalesce(p_tagline, tagline),
    logo_url = nullif(p_logo_url,''), icon_url = nullif(p_icon_url,''),
    primary_color = coalesce(nullif(p_primary_color,''), primary_color),
    support_email = nullif(p_support_email,''), support_phone = nullif(p_support_phone,''),
    updated_at = now(), updated_by = auth.uid()
  where id = 1;
  perform audit(null, 'brand_changed', 'brand_config', null,
    jsonb_build_object('before', v_before, 'after', (select to_jsonb(b) from brand_config b where id = 1)));
end $$;

-- =====================================================================
-- Function grants: signed-in users only (each function checks permissions)
-- =====================================================================
grant execute on function
  public.my_role(uuid), public.is_member(uuid), public.is_owner(uuid), public.has_section(uuid, uuid),
  public.can_view_costs(uuid, uuid), public.can_manage(uuid, uuid), public.can_approve(uuid, uuid),
  public.can_approve_expense(uuid, uuid), public.can_report(uuid, uuid), public.can_view_sale(uuid),
  public.is_platform_admin(),
  public.create_business(text, text[], text, text),
  public.create_invitation(uuid, text, text, boolean, uuid[], boolean),
  public.revoke_invitation(uuid), public.accept_invitation(uuid),
  public.update_member(uuid, text, boolean, uuid[], boolean, boolean),
  public.clock_in(uuid), public.clock_out(uuid, text, timestamptz),
  public.request_price_override(uuid, uuid, numeric, int, text),
  public.decide_price_override(uuid, boolean, numeric, text), public.cancel_price_override(uuid),
  public.finalize_sale(jsonb), public.add_payment(uuid, uuid, numeric, text),
  public.void_sale(uuid, text), public.resolve_sale_review(uuid, boolean, text),
  public.adjust_stock(uuid, int, text, text, numeric), public.set_product_cost(uuid, numeric),
  public.receive_purchase(jsonb), public.flag_stock(uuid, text, text), public.resolve_stock_flag(uuid),
  public.import_products(uuid, jsonb, text),
  public.submit_expense(uuid, uuid, text, numeric, date, text, text, text),
  public.decide_expense(uuid, boolean, text),
  public.report_summary(uuid, date, date, uuid),
  public.update_brand(text, text, text, text, text, text, text)
to authenticated;
grant execute on function public.get_invitation(uuid) to anon, authenticated;

-- audit() is internal only
revoke all on function public.audit(uuid, text, text, uuid, jsonb) from public, anon, authenticated;

-- =====================================================================
-- Storage: one public bucket for product images & logos,
-- files stored under <business_id>/...
-- =====================================================================
create or replace function public.can_upload(p_folder text) returns boolean
language plpgsql stable security definer set search_path = public as $$
begin
  if p_folder !~ '^[0-9a-f-]{36}$' then return false; end if;
  return my_role(p_folder::uuid) in ('owner','section_owner','manager');
end $$;
grant execute on function public.can_upload(text) to authenticated;

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public) values ('shopwise', 'shopwise', true) on conflict (id) do nothing;
    execute $p$
      create policy "shopwise read" on storage.objects for select using (bucket_id = 'shopwise')
    $p$;
    execute $p$
      create policy "shopwise write" on storage.objects for insert to authenticated with check (
        bucket_id = 'shopwise' and public.can_upload((storage.foldername(name))[1]))
    $p$;
    execute $p$
      create policy "shopwise update" on storage.objects for update to authenticated using (
        bucket_id = 'shopwise' and public.can_upload((storage.foldername(name))[1]))
    $p$;
  end if;
end $$;
