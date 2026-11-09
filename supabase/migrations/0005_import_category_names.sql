-- Shopwise 0005: keep category names exactly as written in the sheet
-- ("USB Key", "Phone and Small Batteries"), instead of re-capitalising them.
-- Safe to run more than once.

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
      insert into categories (business_id, name) values (p_business, left(regexp_replace(trim(r->>'category'), '\s+', ' ', 'g'), 80))
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

-- Start over with a clean product list (e.g. after importing the wrong file).
-- Removes only products that were NEVER sold, with their stock history,
-- costs and photos links. Products with sales are kept. Run in the SQL editor:
--   select remove_unsold_products('FRANCONICS STORE');
create or replace function public.remove_unsold_products(p_business_name text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_b uuid; v_n int; v_kept int;
begin
  select id into v_b from businesses where lower(name) = lower(trim(p_business_name)) and not is_demo;
  if v_b is null then raise exception 'No business called "%". Check the exact name in Settings', p_business_name; end if;
  create temp table _gone on commit drop as
    select p.id from products p where p.business_id = v_b
      and not exists (select 1 from sale_lines l where l.product_id = p.id)
      and not exists (select 1 from purchase_lines pl where pl.product_id = p.id);
  delete from price_override_requests where product_id in (select id from _gone);
  delete from stock_movements where product_id in (select id from _gone);
  update products set parent_id = null where parent_id in (select id from _gone);
  delete from products where id in (select id from _gone);
  get diagnostics v_n = row_count;
  select count(*) into v_kept from products where business_id = v_b;
  delete from categories c where c.business_id = v_b and not exists (select 1 from products p where p.category_id = c.id);
  perform audit(v_b, 'unsold_products_removed', 'business', v_b, jsonb_build_object('removed', v_n, 'kept', v_kept));
  return jsonb_build_object('removed', v_n, 'kept_because_sold_or_purchased', v_kept);
end $$;
revoke all on function public.remove_unsold_products(text) from public, anon, authenticated;

-- refresh the API's function list
notify pgrst, 'reload schema';
