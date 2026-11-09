-- Shopwise 0003: optional selling prices, smarter bulk import (by name,
-- add-stock mode, default section), product photos by shopkeepers.
-- Safe to run more than once.

-- 1. Selling prices may be set after import ("Needs price").
alter table public.products alter column target_price drop not null;
alter table public.products alter column min_price drop not null;
alter table public.sale_lines alter column target_price drop not null;
alter table public.sale_lines alter column min_price drop not null;

-- 2. Price override needs a minimum price to compare with.
create or replace function public.request_price_override(
  p_business uuid, p_product uuid, p_price numeric, p_quantity int, p_reason text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_p products; v_id uuid;
begin
  select * into v_p from products where id = p_product and business_id = p_business;
  if not found then raise exception 'Product not found'; end if;
  if v_p.min_price is null then raise exception '% has no selling price yet', v_p.name; end if;
  if not has_section(p_business, v_p.section_id) then raise exception 'You are not assigned to this section'; end if;
  if p_price is null or p_price <= 0 then raise exception 'Enter a valid price'; end if;
  if p_price >= v_p.min_price then raise exception 'This price is allowed without approval'; end if;
  insert into price_override_requests (business_id, section_id, product_id, requested_by, requested_price, quantity, reason)
  values (p_business, v_p.section_id, p_product, auth.uid(), round(p_price, 2), greatest(coalesce(p_quantity,1),1), p_reason)
  returning id into v_id;
  return v_id;
end $$;

-- 3. Sales: block products that have no selling price.
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
    if v_err is null and (v_prod.target_price is null or v_prod.min_price is null) then
      v_err := format('%s has no selling price yet. Ask the owner to set it', v_prod.name);
    end if;
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


-- 4. Bulk import v2
-- rows: [{section, category, name, brand, model, sku, variant_label, description,
--         target_price, min_price, low_stock_threshold, opening_stock, unit_cost}]
-- p_mode:
--   'skip'      existing products are left unchanged
--   'update'    existing products get the file's details/prices (blank cells keep old values)
--   'add_stock' existing products get the file's quantity ADDED (new stock arrival);
--               a unit_cost updates the weighted average cost
-- Existing = same SKU, or (when no SKU) same name + variant in the same business.
-- p_default_section is used for rows without a section.
-- All rows are validated first; nothing is written if any row is invalid.
drop function if exists public.import_products(uuid, jsonb, text);
create or replace function public.import_products(p_business uuid, p_rows jsonb, p_mode text default 'skip', p_default_section uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r jsonb; i int := 0; v_errors jsonb := '[]'::jsonb;
  v_section uuid; v_cat uuid; v_existing products; v_id uuid;
  v_ins int := 0; v_upd int := 0; v_skip int := 0; v_stock int := 0;
  v_target numeric; v_min numeric; v_open int; v_cost numeric;
  v_seen text[] := '{}'; v_key text; v_costs_ok boolean; v_new int;
begin
  if my_role(p_business) not in ('owner','section_owner','manager') then raise exception 'Not allowed to import products'; end if;
  if p_mode not in ('skip','update','add_stock') then raise exception 'Unknown import mode'; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then raise exception 'No rows to import'; end if;
  if jsonb_array_length(p_rows) > 5000 then raise exception 'Import at most 5000 rows at a time'; end if;
  if p_default_section is not null and not exists (select 1 from sections where id = p_default_section and business_id = p_business) then
    raise exception 'Unknown section';
  end if;

  -- validation pass
  for r in select * from jsonb_array_elements(p_rows) loop
    i := i + 1;
    v_section := null;
    if coalesce(trim(r->>'section'),'') <> '' then
      select id into v_section from sections where business_id = p_business and lower(name) = lower(trim(r->>'section'));
    else
      v_section := p_default_section;
    end if;
    begin
      v_target := nullif(trim(r->>'target_price'),'')::numeric;
      v_min := coalesce(nullif(trim(r->>'min_price'),'')::numeric, v_target);
      v_open := coalesce(nullif(trim(r->>'opening_stock'),'')::numeric, 0);
      v_cost := nullif(trim(r->>'unit_cost'),'')::numeric;
    exception when others then
      v_errors := v_errors || jsonb_build_object('row', i, 'message', 'A number column contains text'); continue;
    end;
    if coalesce(trim(r->>'name'),'') = '' then
      v_errors := v_errors || jsonb_build_object('row', i, 'message', 'Name is required');
    elsif v_section is null then
      v_errors := v_errors || jsonb_build_object('row', i, 'message',
        case when coalesce(trim(r->>'section'),'') = '' then 'Choose a section' else format('Unknown section "%s"', r->>'section') end);
    elsif not can_manage(p_business, v_section) then
      v_errors := v_errors || jsonb_build_object('row', i, 'message', 'You cannot manage this section');
    elsif v_target is not null and v_target <= 0 then
      v_errors := v_errors || jsonb_build_object('row', i, 'message', 'Target price must be more than 0 (or leave it empty)');
    elsif v_target is null and nullif(trim(r->>'min_price'),'') is not null then
      v_errors := v_errors || jsonb_build_object('row', i, 'message', 'Give a target price when you give a minimum price');
    elsif v_target is not null and (v_min <= 0 or v_min > v_target) then
      v_errors := v_errors || jsonb_build_object('row', i, 'message', 'Minimum price must be between 1 and the target price');
    elsif v_open < 0 or v_open <> trunc(v_open) then
      v_errors := v_errors || jsonb_build_object('row', i, 'message', 'Quantity must be a whole number, 0 or more');
    elsif v_cost is not null and v_cost < 0 then
      v_errors := v_errors || jsonb_build_object('row', i, 'message', 'Cost cannot be negative');
    end if;
    v_key := case when coalesce(trim(r->>'sku'),'') <> '' then 'sku:' || lower(trim(r->>'sku'))
                  else 'name:' || lower(regexp_replace(trim(r->>'name'), '\s+', ' ', 'g')) || '|' || lower(coalesce(trim(r->>'variant_label'),'')) end;
    if v_key = any(v_seen) then
      v_errors := v_errors || jsonb_build_object('row', i, 'message', 'This product appears twice in the file');
    end if;
    v_seen := v_seen || v_key;
  end loop;
  if jsonb_array_length(v_errors) > 0 then
    return jsonb_build_object('ok', false, 'errors', v_errors);
  end if;

  -- write pass
  for r in select * from jsonb_array_elements(p_rows) loop
    if coalesce(trim(r->>'section'),'') <> '' then
      select id into v_section from sections where business_id = p_business and lower(name) = lower(trim(r->>'section'));
    else
      v_section := p_default_section;
    end if;
    v_costs_ok := can_view_costs(p_business, v_section);
    v_cat := null;
    if coalesce(trim(r->>'category'),'') <> '' then
      insert into categories (business_id, name) values (p_business, initcap(lower(trim(r->>'category'))))
      on conflict (business_id, name) do update set name = excluded.name returning id into v_cat;
    end if;
    v_target := nullif(trim(r->>'target_price'),'')::numeric;
    v_min := coalesce(nullif(trim(r->>'min_price'),'')::numeric, v_target);
    v_open := coalesce(nullif(trim(r->>'opening_stock'),'')::numeric, 0);
    v_cost := nullif(trim(r->>'unit_cost'),'')::numeric;

    v_existing := null;
    if coalesce(trim(r->>'sku'),'') <> '' then
      select * into v_existing from products where business_id = p_business and lower(sku) = lower(trim(r->>'sku')) for update;
    else
      select * into v_existing from products
       where business_id = p_business
         and lower(regexp_replace(name, '\s+', ' ', 'g')) = lower(regexp_replace(trim(r->>'name'), '\s+', ' ', 'g'))
         and lower(coalesce(variant_label,'')) = lower(coalesce(trim(r->>'variant_label'),''))
       order by created_at limit 1 for update;
    end if;

    if v_existing.id is not null then
      if p_mode = 'skip' then v_skip := v_skip + 1; continue; end if;
      if not can_manage(p_business, v_existing.section_id) then
        raise exception '"%" belongs to a section you cannot manage', v_existing.name;
      end if;
      if p_mode = 'update' then
        update products set
          brand = coalesce(nullif(trim(r->>'brand'),''), brand), model = coalesce(nullif(trim(r->>'model'),''), model),
          category_id = coalesce(v_cat, category_id),
          target_price = coalesce(v_target, target_price), min_price = coalesce(v_min, min_price),
          description = coalesce(nullif(trim(r->>'description'),''), description),
          low_stock_threshold = coalesce(nullif(trim(r->>'low_stock_threshold'),'')::int, low_stock_threshold)
        where id = v_existing.id;
        if v_cost is not null and v_costs_ok then
          update product_costs set avg_cost = round(v_cost, 2), updated_at = now() where product_id = v_existing.id;
        end if;
        v_upd := v_upd + 1;
      else -- add_stock
        if v_open > 0 then
          if v_cost is not null and v_costs_ok then perform apply_wac(v_existing.id, v_open, round(v_cost, 2)); end if;
          v_new := v_existing.stock_qty + v_open;
          update products set stock_qty = v_new,
            target_price = coalesce(v_target, target_price), min_price = coalesce(v_min, min_price)
          where id = v_existing.id;
          insert into stock_movements (business_id, section_id, product_id, kind, qty_change, balance_after, reason, created_by)
          values (p_business, v_existing.section_id, v_existing.id, 'purchase', v_open, v_new, 'stock import', auth.uid());
          v_stock := v_stock + 1;
        else
          v_skip := v_skip + 1;
        end if;
      end if;
      continue;
    end if;

    insert into products (business_id, section_id, category_id, name, brand, model, sku, variant_label, description,
                          target_price, min_price, low_stock_threshold)
    values (p_business, v_section, v_cat, regexp_replace(trim(r->>'name'), '\s+', ' ', 'g'), nullif(trim(r->>'brand'),''),
            nullif(trim(r->>'model'),''), nullif(trim(r->>'sku'),''), nullif(trim(r->>'variant_label'),''),
            nullif(trim(r->>'description'),''), v_target, v_min, coalesce(nullif(trim(r->>'low_stock_threshold'),'')::int, 3))
    returning id into v_id;
    if v_cost is not null and v_costs_ok then
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
    jsonb_build_object('mode', p_mode, 'inserted', v_ins, 'updated', v_upd, 'stock_added', v_stock, 'skipped', v_skip));
  return jsonb_build_object('ok', true, 'inserted', v_ins, 'updated', v_upd, 'stock_added', v_stock, 'skipped', v_skip);
end $$;
grant execute on function public.import_products(uuid, jsonb, text, uuid) to authenticated;

-- 5. Product photos. Owners/shop owners/managers can set or replace any photo
--    in their sections. Shopkeepers can ADD a photo to a product in their
--    section that has none yet, but can't replace or remove existing photos.
create or replace function public.set_product_image(p_product uuid, p_url text) returns void
language plpgsql security definer set search_path = public as $$
declare v products;
begin
  select * into v from products where id = p_product for update;
  if not found or not is_member(v.business_id) then raise exception 'Product not found'; end if;
  if p_url is not null and p_url !~ '^https?://' then raise exception 'Invalid image address'; end if;
  if can_manage(v.business_id, v.section_id) then
    update products set image_url = p_url where id = p_product;
  elsif my_role(v.business_id) = 'staff' and has_section(v.business_id, v.section_id) then
    if v.image_url is not null then raise exception 'This product already has a photo. Ask a manager to change it'; end if;
    if p_url is null then raise exception 'Not allowed'; end if;
    update products set image_url = p_url where id = p_product;
  else
    raise exception 'You cannot change photos in this section';
  end if;
  perform audit(v.business_id, 'product_photo_set', 'product', p_product, jsonb_build_object('before', v.image_url, 'after', p_url));
end $$;
grant execute on function public.set_product_image(uuid, text) to authenticated;

-- uploads into <business_id>/... : any active member except read-only accountants
create or replace function public.can_upload(p_folder text) returns boolean
language plpgsql stable security definer set search_path = public as $$
begin
  if p_folder !~ '^[0-9a-f-]{36}$' then return false; end if;
  return my_role(p_folder::uuid) in ('owner','section_owner','manager','staff');
end $$;

-- 6. Invitations can carry the person's WhatsApp number (used to send the
--    link and saved to their profile when they join).
alter table public.invitations add column if not exists phone text;

drop function if exists public.create_invitation(uuid, text, text, boolean, uuid[], boolean);
create or replace function public.create_invitation(
  p_business uuid, p_email text, p_role text, p_all_sections boolean, p_section_ids uuid[], p_can_view_costs boolean,
  p_phone text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_token uuid; v_id uuid;
begin
  if not is_owner(p_business) then raise exception 'Only a super admin can invite people'; end if;
  if p_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Enter a valid email address'; end if;
  if p_role not in ('owner','section_owner','manager','staff','accountant') then raise exception 'Unknown role'; end if;
  if p_phone is not null and length(regexp_replace(p_phone, '\D', '', 'g')) not between 8 and 15 then
    raise exception 'Enter a valid WhatsApp number (e.g. 6XX XXX XXX)';
  end if;
  if exists (select 1 from unnest(coalesce(p_section_ids,'{}')) sid
             where not exists (select 1 from sections where id = sid and business_id = p_business)) then
    raise exception 'Section does not belong to this business';
  end if;
  insert into invitations (business_id, email, role, all_sections, section_ids, can_view_costs, invited_by, phone)
  values (p_business, lower(trim(p_email)), p_role, p_role = 'owner' or coalesce(p_all_sections,false),
          coalesce(p_section_ids,'{}'), p_role <> 'staff' and coalesce(p_can_view_costs,false) or p_role = 'owner',
          auth.uid(), nullif(trim(p_phone), ''))
  returning id, token into v_id, v_token;
  perform audit(p_business, 'invitation_created', 'invitation', v_id,
                jsonb_build_object('email', lower(p_email), 'role', p_role));
  return v_token;
end $$;
grant execute on function public.create_invitation(uuid, text, text, boolean, uuid[], boolean, text) to authenticated;

create or replace function public.invitation_phone_to_profile() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.accepted_at is not null and old.accepted_at is null and new.phone is not null then
    update profiles p set phone = new.phone
    where p.phone is null and p.user_id = (select user_id from memberships m where m.business_id = new.business_id
                                             and m.user_id = auth.uid());
  end if;
  return new;
end $$;
drop trigger if exists invitations_phone_to_profile on public.invitations;
create trigger invitations_phone_to_profile after update of accepted_at on public.invitations
  for each row execute function public.invitation_phone_to_profile();

-- refresh the API's function list
notify pgrst, 'reload schema';
