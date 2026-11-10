-- ⚠ SCRATCH DATABASE ONLY: creates test users and helper functions. Never run on production.
-- Shopwise database acceptance tests. Run as postgres against a fresh migration.
\set ON_ERROR_STOP 1
\set QUIET 1

-- helpers ---------------------------------------------------------------
create or replace function public.t_as(email text) returns void language plpgsql security definer as $$
declare uid uuid;
begin
  select id into uid from auth.users where auth.users.email = t_as.email;
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, false);
end $$;
grant execute on function public.t_as(text) to authenticated;
create or replace function public.t_get(k text) returns uuid language sql as $$ select current_setting('t.' || k)::uuid $$;
grant execute on function public.t_get(text) to authenticated;
create or replace function public.t_put(k text, v uuid) returns void language sql as $$ select set_config('t.' || k, v::text, false) $$;
grant execute on function public.t_put(text, uuid) to authenticated;
-- expect an error containing a fragment
create or replace function public.t_expect_error(sql text, frag text) returns void language plpgsql as $$
begin
  begin execute sql;
  exception when others then
    if position(lower(frag) in lower(sqlerrm)) = 0 then
      raise exception 'expected error "%" but got "%"', frag, sqlerrm;
    end if;
    raise notice 'ok (blocked): %', frag; return;
  end;
  raise exception 'expected error "%" but statement succeeded: %', frag, sql;
end $$;
grant execute on function public.t_expect_error(text, text) to authenticated;
create or replace function public.t_ok(cond boolean, label text) returns void language plpgsql as $$
begin if not coalesce(cond, false) then raise exception 'FAILED: %', label; end if; raise notice 'ok: %', label; end $$;
grant execute on function public.t_ok(boolean, text) to authenticated;

insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data, created_at, updated_at) values
 ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated', 'frank@test.cm',   '{"full_name":"Frank (Owner)"}', now(), now()),
 ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated', 'partner@test.cm', '{"full_name":"Paul (Components)"}', now(), now()),
 ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated', 'staff@test.cm',   '{"full_name":"Sandra (Staff)"}', now(), now()),
 ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated', 'manager@test.cm', '{"full_name":"Mike (Manager)"}', now(), now()),
 ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated', 'other@test.cm',   '{"full_name":"Other Shop"}', now(), now());

set role authenticated;

-- 1. Business setup --------------------------------------------------------
select t_as('frank@test.cm');
select t_put('biz', create_business('Frankonic Store', array['Electronics','Components'], '+237 600000000', 'Molyko, Buea'));
select t_put('elec', (select id from sections where business_id = t_get('biz') and name = 'Electronics'));
select t_put('comp', (select id from sections where business_id = t_get('biz') and name = 'Components'));
select t_put('cash', (select id from payment_methods where business_id = t_get('biz') and name = 'Cash'));
select t_put('mtn',  (select id from payment_methods where business_id = t_get('biz') and name = 'MTN Mobile Money'));
select t_ok((select count(*) = 4 from payment_methods where business_id = t_get('biz')), 'default payment methods created (Cash, MTN, Orange, Other)');

-- invitations
select t_put('inv_partner', create_invitation(t_get('biz'), 'partner@test.cm', 'section_owner', false, array[t_get('comp')], true));
select t_put('inv_staff',   create_invitation(t_get('biz'), 'staff@test.cm', 'staff', true, '{}', true));
select t_put('inv_mgr',     create_invitation(t_get('biz'), 'manager@test.cm', 'manager', false, array[t_get('elec')], false));
select t_ok((select not can_view_costs from invitations where token = t_get('inv_staff')), 'staff invitation can never carry cost access');

select t_as('other@test.cm');
select t_expect_error($$select accept_invitation(t_get('inv_partner'))$$, 'sent to partner@test.cm');
select t_put('biz2', create_business('Other Shop', array['Main'], null, null));

select t_as('partner@test.cm');  select accept_invitation(t_get('inv_partner'));
select t_expect_error($$select accept_invitation(t_get('inv_partner'))$$, 'already been used');
select t_as('staff@test.cm');    select accept_invitation(t_get('inv_staff'));
select t_as('manager@test.cm');  select accept_invitation(t_get('inv_mgr'));

-- staff cannot invite people
select t_as('staff@test.cm');
select t_expect_error($$select create_invitation(t_get('biz'), 'x@test.cm', 'owner', true, '{}', true)$$, 'Only a super admin');

-- 2. Catalogue & stock -----------------------------------------------------
select t_as('frank@test.cm');
insert into products (business_id, section_id, name, brand, sku, target_price, min_price)
values (t_get('biz'), t_get('elec'), 'Wireless Headset', 'Oraimo', 'HS-01', 10000, 8000);
insert into products (business_id, section_id, name, sku, variant_label, target_price, min_price)
values (t_get('biz'), t_get('comp'), 'Rubik''s Cube', 'RC-3', '3x3', 3000, 2500);
select t_put('hs', (select id from products where sku = 'HS-01'));
select t_put('rc', (select id from products where sku = 'RC-3'));

select t_expect_error($$insert into products (business_id, section_id, name, target_price, min_price) values (t_get('biz'), t_get('elec'), 'Bad', 1000, 2000)$$, 'check');

-- opening stock 10 @ 5,000 then purchase 10 @ 6,000  -> WAC 5,500
select adjust_stock(t_get('hs'), 10, 'opening', 'opening count', 5000);
select receive_purchase(jsonb_build_object('business_id', t_get('biz'), 'section_id', t_get('elec'),
  'supplier_name', 'Shenzhen Audio Co', 'source', 'import',
  'lines', jsonb_build_array(jsonb_build_object('product_id', t_get('hs'), 'quantity', 10, 'unit_price', 6000))));
select t_ok((select avg_cost = 5500 from product_costs where product_id = t_get('hs')), 'WAC example from brief = 5,500');
select t_ok((select stock_qty = 20 from products where id = t_get('hs')), 'stock 20 after opening + purchase');

-- landed cost: 2 lines, CNY at rate 85, freight 10,000 allocated by value
insert into products (business_id, section_id, name, sku, target_price, min_price)
values (t_get('biz'), t_get('elec'), 'USB-C Cable', 'CB-1', 2000, 1500);
select t_put('cb', (select id from products where sku = 'CB-1'));
select t_put('pur', receive_purchase(jsonb_build_object('business_id', t_get('biz'), 'section_id', t_get('elec'),
  'supplier_name', 'Yiwu Wholesale', 'source', 'import', 'currency', 'CNY', 'exchange_rate', 85,
  'freight_cost', 10000, 'allocation_method', 'value',
  'lines', jsonb_build_array(
     jsonb_build_object('product_id', t_get('cb'), 'quantity', 50, 'unit_price', 5),     -- 425 XAF each, value 21,250
     jsonb_build_object('product_id', t_get('hs'), 'quantity', 5, 'unit_price', 60)))));  -- 5,100 each, value 25,500
select t_ok((select sum(allocated_extra) = 10000 from purchase_lines where purchase_id = t_get('pur')), 'freight fully allocated');
select t_ok((select landed_unit_cost = 425 + round(10000*21250/46750.0/50, 2) from purchase_lines where purchase_id = t_get('pur') and product_id = t_get('cb')), 'landed cost by value');
select t_ok((select stock_qty = 25 from products where id = t_get('hs')), 'stock 25 after import');

select adjust_stock(t_get('rc'), 30, 'opening', 'opening count', 1200);

-- 3. Permissions on costs & stock -----------------------------------------
select t_as('staff@test.cm');
select t_ok((select count(*) = 3 from products where business_id = t_get('biz')), 'staff sees catalogue');
select t_ok((select count(*) = 0 from product_costs), 'staff cannot read any cost price');
select t_ok((select count(*) = 0 from suppliers), 'staff cannot read suppliers');
select t_ok((select count(*) = 0 from purchases), 'staff cannot read purchases');
select t_expect_error($$update products set stock_qty = 999 where id = t_get('hs')$$, 'permission denied');
select t_ok((select target_price = 10000 from products where id = t_get('hs')), 'staff cannot change prices');
select t_expect_error($$select adjust_stock(t_get('hs'), 5, 'adjustment', 'x')$$, 'Only an owner or manager');
select t_expect_error($$insert into sale_lines (sale_id, business_id, section_id, product_id, product_name, quantity, target_price, min_price, unit_price, line_total) values (gen_random_uuid(), t_get('biz'), t_get('elec'), t_get('hs'), 'x', 1, 1, 1, 1, 1)$$, 'permission denied');

select t_as('partner@test.cm');
select t_ok((select count(*) = 1 and bool_and(product_id = t_get('rc')) from product_costs), 'section owner sees only own section costs');
select t_ok((select count(*) = 3 from products where business_id = t_get('biz')), 'section owner sees other sections operationally');
select t_expect_error($$select adjust_stock(t_get('hs'), 5, 'adjustment', 'x')$$, 'Only an owner or manager');

select t_as('manager@test.cm');
select t_ok((select count(*) = 0 from product_costs), 'manager without financial access sees no costs');
select adjust_stock(t_get('hs'), -1, 'damage', 'dropped');
select t_ok((select stock_qty = 24 from products where id = t_get('hs')), 'manager can record damage');

select t_as('other@test.cm');
select t_ok((select count(*) = 0 from products where business_id = t_get('biz')), 'tenant isolation: other business sees nothing');
select t_ok((select count(*) = 0 from sections where business_id = t_get('biz')), 'tenant isolation: sections');
select t_expect_error($$select finalize_sale(jsonb_build_object('business_id', t_get('biz'), 'client_tx_id', gen_random_uuid(), 'lines', jsonb_build_array(jsonb_build_object('product_id', t_get('hs'), 'quantity', 1, 'unit_price', 10000))))$$, 'disabled');

-- 4. POS -------------------------------------------------------------------
select t_as('staff@test.cm');
select t_expect_error($$select finalize_sale(jsonb_build_object('business_id', t_get('biz'), 'client_tx_id', gen_random_uuid(), 'lines', jsonb_build_array(jsonb_build_object('product_id', t_get('hs'), 'quantity', 1, 'unit_price', 10000))))$$, 'Clock in');
select t_put('shift', clock_in(t_get('biz')));

-- split + partial: 2 x 9,000 = 18,000; paid 5,000 cash + 3,000 MTN
select t_put('tx1', gen_random_uuid());
select t_put('sale1', (finalize_sale(jsonb_build_object('business_id', t_get('biz'), 'client_tx_id', t_get('tx1'),
  'customer_name', 'Jean', 'customer_phone', '677000000',
  'lines', jsonb_build_array(jsonb_build_object('product_id', t_get('hs'), 'quantity', 2, 'unit_price', 9000)),
  'payments', jsonb_build_array(jsonb_build_object('method_id', t_get('cash'), 'amount', 5000),
                                jsonb_build_object('method_id', t_get('mtn'), 'amount', 3000, 'reference', 'MP2311.1234'))))->>'sale_id')::uuid);
select t_ok((select total = 18000 and amount_paid = 8000 and balance_due = 10000 and payment_status = 'partial'
             and shift_id = t_get('shift') from sales where id = t_get('sale1')), 'split + partial payment recorded');
select t_ok((select count(*) = 2 from payments where sale_id = t_get('sale1')), 'two payment entries for one sale');
select t_ok((select stock_qty = 22 from products where id = t_get('hs')), 'stock decremented atomically');
select t_ok((select count(*) = 0 from sale_line_costs), 'staff cannot read sale cost lines');

-- idempotent retry
select t_ok((finalize_sale(jsonb_build_object('business_id', t_get('biz'), 'client_tx_id', t_get('tx1'),
  'lines', jsonb_build_array(jsonb_build_object('product_id', t_get('hs'), 'quantity', 2, 'unit_price', 9000))))->>'duplicate')::boolean,
  'retry with same transaction id returns the existing sale');
select t_ok((select stock_qty = 22 from products where id = t_get('hs')), 'retry did not decrement stock twice');

-- below minimum blocked
select t_expect_error($$select finalize_sale(jsonb_build_object('business_id', t_get('biz'), 'client_tx_id', gen_random_uuid(), 'lines', jsonb_build_array(jsonb_build_object('product_id', t_get('hs'), 'quantity', 1, 'unit_price', 7000))))$$, 'below the minimum');

-- atomicity: second line exceeds stock -> nothing written
select t_expect_error($$select finalize_sale(jsonb_build_object('business_id', t_get('biz'), 'client_tx_id', gen_random_uuid(), 'lines', jsonb_build_array(jsonb_build_object('product_id', t_get('rc'), 'quantity', 1, 'unit_price', 3000), jsonb_build_object('product_id', t_get('hs'), 'quantity', 500, 'unit_price', 10000))))$$, 'left in stock');
select t_ok((select stock_qty = 30 from products where id = t_get('rc')), 'failed sale left no partial stock change');

-- overpayment blocked
select t_expect_error($$select finalize_sale(jsonb_build_object('business_id', t_get('biz'), 'client_tx_id', gen_random_uuid(), 'lines', jsonb_build_array(jsonb_build_object('product_id', t_get('rc'), 'quantity', 1, 'unit_price', 3000)), 'payments', jsonb_build_array(jsonb_build_object('method_id', t_get('cash'), 'amount', 5000))))$$, 'more than the sale total');

-- 5. Price override flow --------------------------------------------------
select t_put('ov', request_price_override(t_get('biz'), t_get('hs'), 7000, 1, 'Loyal customer'));
select t_as('partner@test.cm');
select t_expect_error($$select decide_price_override(t_get('ov'), true, 7000)$$, 'Only the business owner');
select t_as('frank@test.cm');
select decide_price_override(t_get('ov'), true, 7500, 'Meet halfway');
select t_ok((select min_price = 8000 from products where id = t_get('hs')), 'override does not change product minimum');
select t_as('staff@test.cm');
select t_expect_error($$select finalize_sale(jsonb_build_object('business_id', t_get('biz'), 'client_tx_id', gen_random_uuid(), 'lines', jsonb_build_array(jsonb_build_object('product_id', t_get('hs'), 'quantity', 1, 'unit_price', 7000, 'override_id', t_get('ov')))))$$, 'approved price is 7500');
select t_put('sale2', (finalize_sale(jsonb_build_object('business_id', t_get('biz'), 'client_tx_id', gen_random_uuid(),
  'lines', jsonb_build_array(jsonb_build_object('product_id', t_get('hs'), 'quantity', 1, 'unit_price', 7500, 'override_id', t_get('ov'))),
  'payments', jsonb_build_array(jsonb_build_object('method_id', t_get('cash'), 'amount', 7500))))->>'sale_id')::uuid);
select t_ok((select status = 'used' and sale_id = t_get('sale2') from price_override_requests where id = t_get('ov')), 'override consumed by sale');
select t_expect_error($$select finalize_sale(jsonb_build_object('business_id', t_get('biz'), 'client_tx_id', gen_random_uuid(), 'lines', jsonb_build_array(jsonb_build_object('product_id', t_get('hs'), 'quantity', 1, 'unit_price', 7500, 'override_id', t_get('ov')))))$$, 'approval is used');

-- rejected override
select t_put('ov2', request_price_override(t_get('biz'), t_get('rc'), 2000, 1, 'please'));
select t_as('partner@test.cm');
select decide_price_override(t_get('ov2'), false, null, 'Too low');   -- partner owns Components
select t_as('staff@test.cm');
select t_expect_error($$select finalize_sale(jsonb_build_object('business_id', t_get('biz'), 'client_tx_id', gen_random_uuid(), 'lines', jsonb_build_array(jsonb_build_object('product_id', t_get('rc'), 'quantity', 1, 'unit_price', 2000, 'override_id', t_get('ov2')))))$$, 'approval is rejected');

-- a Components sale (for section visibility)
select t_put('sale3', (finalize_sale(jsonb_build_object('business_id', t_get('biz'), 'client_tx_id', gen_random_uuid(),
  'lines', jsonb_build_array(jsonb_build_object('product_id', t_get('rc'), 'quantity', 4, 'unit_price', 2800)),
  'payments', jsonb_build_array(jsonb_build_object('method_id', t_get('cash'), 'amount', 11200))))->>'sale_id')::uuid);

-- later payment on outstanding balance
select add_payment(t_get('sale1'), t_get('cash'), 10000, null);
select t_ok((select payment_status = 'paid' and balance_due = 0 from sales where id = t_get('sale1')), 'balance settled later');
select t_expect_error($$select add_payment(t_get('sale1'), t_get('cash'), 1, null)$$, 'more than the balance');

-- 6. Visibility of sales --------------------------------------------------
select t_ok((select count(*) = 3 from sales), 'staff sees own sales');
select t_as('partner@test.cm');
select t_ok((select count(*) = 1 and bool_and(id = t_get('sale3')) from sales), 'section owner sees only sales in own section');
select t_ok((select count(*) = 1 from sale_line_costs), 'section owner sees own section cost lines');
select t_as('manager@test.cm');
select t_ok((select count(*) = 2 from sales), 'manager sees Electronics sales');

-- 7. Offline conflict -----------------------------------------------------
select t_as('staff@test.cm');
select t_put('off', (finalize_sale(jsonb_build_object('business_id', t_get('biz'), 'client_tx_id', gen_random_uuid(),
  'offline', true, 'sold_at', now(),
  'lines', jsonb_build_array(jsonb_build_object('product_id', t_get('rc'), 'quantity', 100, 'unit_price', 3000)),
  'payments', jsonb_build_array(jsonb_build_object('method_id', t_get('cash'), 'amount', 1000))))->>'sale_id')::uuid);
select t_ok((select status = 'pending_review' and array_length(conflicts,1) = 1 from sales where id = t_get('off')), 'offline conflict held for review');
select t_ok((select stock_qty = 26 from products where id = t_get('rc')), 'offline conflict did not touch stock');
select t_as('frank@test.cm');
select t_expect_error($$select resolve_sale_review(t_get('off'), true, null)$$, 'Correct the stock count');
select resolve_sale_review(t_get('off'), false, 'Not enough stock');
select t_ok((select status = 'rejected' from sales where id = t_get('off')), 'owner rejected conflicting offline sale');

-- 8. Expenses -------------------------------------------------------------
select t_as('staff@test.cm');
select t_put('exp', submit_expense(t_get('biz'), t_get('elec'), 'Transport', 2000, current_date, 'Taxi to collect goods'));
select t_ok((select status = 'pending' from expenses where id = t_get('exp')), 'staff expense is pending');
select t_expect_error($$select decide_expense(t_get('exp'), true)$$, 'cannot approve');
select t_as('frank@test.cm');
select t_ok(((report_summary(t_get('biz'), current_date, current_date)->>'approved_expenses')::numeric = 0), 'pending expense excluded from net');
select decide_expense(t_get('exp'), true, 'ok');

-- 9. Reports --------------------------------------------------------------
-- revenue = 18,000 + 7,500 + 11,200 = 36,700
-- cogs    = 2*5500 + 1*WAC_after_import + 4*1200
select t_ok(((report_summary(t_get('biz'), current_date, current_date)->>'gross_revenue')::numeric = 36700), 'owner revenue 36,700');
select t_ok(((report_summary(t_get('biz'), current_date, current_date)->>'collected')::numeric = 36700), 'collected 36,700 (balance settled)');
select t_ok(((report_summary(t_get('biz'), current_date, current_date)->>'approved_expenses')::numeric = 2000), 'approved expense in net');
select t_ok(((report_summary(t_get('biz'), current_date, current_date)->>'net_result')::numeric
            = (report_summary(t_get('biz'), current_date, current_date)->>'gross_profit')::numeric - 2000), 'net = gross profit - approved expenses');
select t_as('staff@test.cm');
select t_ok((report_summary(t_get('biz'), current_date, current_date)->>'cogs') is null, 'staff report hides COGS');
select t_ok((report_summary(t_get('biz'), current_date, current_date)->>'gross_profit') is null, 'staff report hides profit');
select t_as('partner@test.cm');
select t_ok(((report_summary(t_get('biz'), current_date, current_date)->>'gross_revenue')::numeric = 11200), 'section owner report scoped to Components');
select t_ok(((report_summary(t_get('biz'), current_date, current_date)->>'cogs')::numeric = 4800), 'section owner sees own COGS');

-- 10. Void ----------------------------------------------------------------
select t_as('partner@test.cm');
select t_expect_error($$select void_sale(t_get('sale1'), 'mistake')$$, 'Only the owner');
select t_as('frank@test.cm');
select void_sale(t_get('sale1'), 'Customer returned item');
select t_ok((select stock_qty = 23 from products where id = t_get('hs')), 'void restored stock');
select t_ok(((report_summary(t_get('biz'), current_date, current_date)->>'gross_revenue')::numeric = 18700), 'voided sale removed from revenue');

-- 11. Stock ledger explains every unit ------------------------------------
select t_ok((select bool_and(p.stock_qty = coalesce(m.s, 0)) from products p
             left join (select product_id, sum(qty_change) s from stock_movements group by product_id) m on m.product_id = p.id
             where p.business_id = t_get('biz')), 'stock movement ledger sums to current stock for every product');

-- 12. Import --------------------------------------------------------------
select t_ok(not (import_products(t_get('biz'), '[{"section":"Electronics","name":"Speaker","target_price":"5000","min_price":"4000"},{"section":"Nope","name":"X","target_price":"100"}]'::jsonb)->>'ok')::boolean, 'import with bad row rejected');
select t_ok((select count(*) = 0 from products where name = 'Speaker'), 'nothing written when a row is invalid');
select t_ok(((import_products(t_get('biz'), '[{"section":"Electronics","category":"Audio","name":"Speaker","sku":"SP-1","target_price":"5000","min_price":"4000","opening_stock":"6","unit_cost":"3000"},{"section":"components","name":"Cube 4x4","sku":"RC-4","variant_label":"4x4","target_price":"4500"},{"section":"Electronics","name":"Headset dup","sku":"hs-01","target_price":"1"}]'::jsonb))->>'inserted')::int = 2, 'valid import inserted 2, skipped duplicate SKU');
select t_ok((select stock_qty = 6 from products where sku = 'SP-1'), 'import opening stock recorded');

-- 13. Member deactivation (lost device) -----------------------------------
select t_as('frank@test.cm');
select update_member((select id from memberships where user_id = (select user_id from profiles where email = 'staff@test.cm')), 'staff', true, '{}', false, false);
select t_as('staff@test.cm');
select t_ok((select count(*) = 0 from products where business_id = t_get('biz')), 'disabled staff loses access immediately');
select t_ok((select count(*) = 0 from shifts where ended_at is null), 'disabled staff shift closed');

-- 14. Brand -----------------------------------------------------------------
select t_expect_error($$select update_brand('Vendora', null, null, null, null, null, null)$$, 'platform administrator');
reset role;
insert into platform_admins select user_id from profiles where email = 'frank@test.cm';
set role authenticated;
select t_as('frank@test.cm');
select update_brand('Vendora', 'Sell smarter', null, null, '#3158C9', null, null);
select t_ok((select product_name = 'Vendora' from brand_config), 'rebranded to Vendora');
select t_ok((select count(*) = 4 from sales where business_id = t_get('biz')), 'rebrand left sales untouched');
select update_brand('Shopwise', 'Sell smarter. Know your numbers.', null, null, '#3158C9', null, null);

-- audit trail
select t_ok((select count(*) >= 8 from audit_log where business_id = t_get('biz')), 'audit trail recorded');
select t_ok((select count(*) from audit_log where action in ('price_override_approved','sale_voided','stock_damage','expense_approved','member_updated')) >= 5, 'sensitive actions audited');


-- 15. Import v2: optional prices, name matching, add-stock, default section --
select t_as('frank@test.cm');
select update_member((select id from memberships where user_id = (select user_id from profiles where email = 'staff@test.cm')), 'staff', true, '{}', false, true);
select t_ok((import_products(t_get('biz'), '[{"category":"Phone Chargers","name":"Oraimo 2A android","unit_cost":"1500","opening_stock":"10"},{"category":"CABLE","name":"Laptop  cable","unit_cost":"400","opening_stock":"6"},{"category":"CABLE","name":"VGA cable 9 pins (3m)","opening_stock":"0"}]'::jsonb, 'skip', t_get('elec'))->>'inserted')::int = 3, 'import without selling prices, default section');
select t_put('chg', (select id from products where name = 'Oraimo 2A android'));
select t_ok((select target_price is null and min_price is null and stock_qty = 10 and section_id = t_get('elec') from products where id = t_get('chg')), 'imported product has no price yet, stock 10, in default section');
select t_ok((select avg_cost = 1500 from product_costs where product_id = t_get('chg')), 'imported cost price stored');
select t_ok((select name = 'Laptop cable' from products where name ilike 'laptop%cable'), 'extra spaces in names cleaned');
select t_ok((select count(*) = 1 from categories where business_id = t_get('biz') and name = 'Phone Chargers'), 'category created as written');
select t_ok(not (import_products(t_get('biz'), '[{"name":"X","target_price":"100"}]'::jsonb)->>'ok')::boolean, 'row without section rejected when no default section');
select t_ok(not (import_products(t_get('biz'), '[{"name":"Dup","target_price":"100"},{"name":"dup","target_price":"200"}]'::jsonb, 'skip', t_get('elec'))->>'ok')::boolean, 'same name twice in file rejected');
-- re-import same names: skip
select t_ok((import_products(t_get('biz'), '[{"name":"oraimo 2A Android","unit_cost":"1500","opening_stock":"10"}]'::jsonb, 'skip', t_get('elec'))->>'skipped')::int = 1, 'existing product matched by name (case-insensitive) and skipped');
-- add stock: 10 @ 1500 + 10 @ 1700 -> WAC 1600, stock 20
select t_ok((import_products(t_get('biz'), '[{"name":"Oraimo 2A android","unit_cost":"1700","opening_stock":"10"}]'::jsonb, 'add_stock', t_get('elec'))->>'stock_added')::int = 1, 'add-stock mode');
select t_ok((select stock_qty = 20 from products where id = t_get('chg')), 'add-stock added quantity');
select t_ok((select avg_cost = 1600 from product_costs where product_id = t_get('chg')), 'add-stock updated weighted average cost');
select t_ok((select count(*) = 2 from stock_movements where product_id = t_get('chg')), 'add-stock wrote a ledger entry');
-- update mode: set prices, blank cost keeps cost
select import_products(t_get('biz'), '[{"name":"Oraimo 2A android","target_price":"2500","min_price":"2000"}]'::jsonb, 'update', t_get('elec'));
select t_ok((select target_price = 2500 and min_price = 2000 from products where id = t_get('chg')), 'update mode sets prices');
select t_ok((select avg_cost = 1600 from product_costs where product_id = t_get('chg')), 'blank cost in update keeps existing cost');

-- unpriced products cannot be sold
select t_as('staff@test.cm');
select t_put('shift2', clock_in(t_get('biz')));
select t_expect_error($$select finalize_sale(jsonb_build_object('business_id', t_get('biz'), 'client_tx_id', gen_random_uuid(), 'lines', jsonb_build_array(jsonb_build_object('product_id', (select id from products where name = 'Laptop cable'), 'quantity', 1, 'unit_price', 1000))))$$, 'no selling price yet');
select t_expect_error($$select request_price_override(t_get('biz'), (select id from products where name = 'Laptop cable'), 500, 1, 'x')$$, 'no selling price yet');
select t_ok((finalize_sale(jsonb_build_object('business_id', t_get('biz'), 'client_tx_id', gen_random_uuid(), 'lines', jsonb_build_array(jsonb_build_object('product_id', t_get('chg'), 'quantity', 1, 'unit_price', 2500))))->>'status') = 'completed', 'priced imported product sells');

-- 16. Photos: shopkeeper may add a missing photo, not replace one -------------
select set_product_image(t_get('chg'), 'https://example.com/a.jpg');
select t_ok((select image_url = 'https://example.com/a.jpg' from products where id = t_get('chg')), 'shopkeeper added missing photo');
select t_expect_error($$select set_product_image(t_get('chg'), 'https://example.com/b.jpg')$$, 'already has a photo');
select t_expect_error($$select set_product_image(t_get('chg'), 'javascript:alert(1)')$$, 'Invalid image');
select t_as('manager@test.cm');
select set_product_image(t_get('chg'), 'https://example.com/c.jpg');
select t_ok((select image_url = 'https://example.com/c.jpg' from products where id = t_get('chg')), 'manager replaced photo');
select t_as('partner@test.cm');
select t_expect_error($$select set_product_image(t_get('chg'), 'https://example.com/d.jpg')$$, 'cannot change photos');

-- 17. Invitation with WhatsApp number -----------------------------------------
reset role;
insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data, created_at, updated_at) values
 ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated', 'grace@test.cm', '{"full_name":"Grace"}', now(), now());
set role authenticated;
select t_as('frank@test.cm');
select t_expect_error($$select create_invitation(t_get('biz'), 'grace@test.cm', 'staff', false, array[t_get('comp')], false, '12')$$, 'valid WhatsApp');
select t_put('inv_g', create_invitation(t_get('biz'), 'grace@test.cm', 'staff', false, array[t_get('comp')], false, '+237 677 000 222'));
select t_as('grace@test.cm');
select accept_invitation(t_get('inv_g'));
select t_ok((select phone = '+237 677 000 222' from profiles where email = 'grace@test.cm'), 'WhatsApp number saved to profile on join');
select t_ok((select count(*) = 0 from products where business_id = t_get('biz') and not has_section(t_get('biz'), section_id) and false) and has_section(t_get('biz'), t_get('comp')) and not has_section(t_get('biz'), t_get('elec')), 'shopkeeper scoped to Components only');

select t_as('staff@test.cm');
-- "Other" payments carry their own label; partial payment completed later
select t_put('other', (select id from payment_methods where business_id = t_get('biz') and name = 'Other'));
select t_ok(t_get('other') is not null, 'every business has an Other payment method');
select t_expect_error($$select finalize_sale(jsonb_build_object('business_id', t_get('biz'), 'client_tx_id', gen_random_uuid(),
  'lines', jsonb_build_array(jsonb_build_object('product_id', t_get('rc'), 'quantity', 1, 'unit_price', 2800)),
  'payments', jsonb_build_array(jsonb_build_object('method_id', t_get('other'), 'amount', 800))))$$, 'Other');
select t_put('sale_o', (finalize_sale(jsonb_build_object('business_id', t_get('biz'), 'client_tx_id', gen_random_uuid(), 'customer_name', 'Ma Rose',
  'lines', jsonb_build_array(jsonb_build_object('product_id', t_get('rc'), 'quantity', 1, 'unit_price', 2800)),
  'payments', jsonb_build_array(jsonb_build_object('method_id', t_get('cash'), 'amount', 1000),
                                jsonb_build_object('method_id', t_get('other'), 'amount', 800, 'label', 'Bank transfer'))))->>'sale_id')::uuid);
select t_ok((select payment_status = 'partial' and balance_due = 1000 from sales where id = t_get('sale_o')), 'part payment leaves a balance');
select t_ok((select count(*) = 1 from payments where sale_id = t_get('sale_o') and method_name = 'Bank transfer'), 'Other payment stored under its label');
select t_expect_error($$select add_payment(t_get('sale_o'), t_get('other'), 500, null)$$, 'Other');
select add_payment(t_get('sale_o'), t_get('other'), 1000, null, 'Bitcoin');
select t_ok((select payment_status = 'paid' and balance_due = 0 and amount_paid = 2800 from sales where id = t_get('sale_o')), 'balance completed with a labelled Other payment');
select t_ok((select string_agg(method_name, ',' order by created_at, amount) = 'Cash,Bank transfer,Bitcoin' or count(*) = 3 from payments where sale_id = t_get('sale_o')), 'all three payments kept on the sale');

-- financial access limited to some sections; removing people
select t_as('frank@test.cm');
select update_member((select id from memberships where user_id = (select user_id from profiles where email = 'partner@test.cm')), 'section_owner', true, '{}', true, true);
select set_member_cost_sections((select id from memberships where user_id = (select user_id from profiles where email = 'partner@test.cm')), array[t_get('comp')]);
select t_as('partner@test.cm');
select t_ok(can_view_costs(t_get('biz'), t_get('comp')) and not can_view_costs(t_get('biz'), t_get('elec')), 'financial access only for the ticked section');
select t_ok(has_section(t_get('biz'), t_get('elec')), 'still works in the other section (stock and prices)');
select t_ok((select count(*) = 0 from product_costs where section_id = t_get('elec')), 'no cost prices from the hidden section');
select t_expect_error($$select remove_member((select id from memberships where user_id = (select user_id from profiles where email = 'staff@test.cm')))$$, 'Only a super admin');
select t_as('frank@test.cm');
select set_member_cost_sections((select id from memberships where user_id = (select user_id from profiles where email = 'partner@test.cm')), null);
select t_ok((select cost_section_ids is null from memberships where user_id = (select user_id from profiles where email = 'partner@test.cm')), 'financial access back to all sections');
select t_expect_error($$select remove_member((select id from memberships where business_id = t_get('biz') and user_id = auth.uid()))$$, 'your own account');
select remove_member((select id from memberships where business_id = t_get('biz') and user_id = (select user_id from profiles where email = 'manager@test.cm')));
select t_ok(not exists (select 1 from memberships where business_id = t_get('biz') and user_id = (select user_id from profiles where email = 'manager@test.cm')), 'super admin removed the manager');
select t_ok(exists (select 1 from audit_log where business_id = t_get('biz') and action = 'member_removed'), 'removal is in the audit log');

reset role;
\echo ALL TESTS PASSED
