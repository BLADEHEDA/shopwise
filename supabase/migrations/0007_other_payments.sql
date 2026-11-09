-- 0007: "Other" payment method with a free label (Bank transfer, Bitcoin, …)
-- and later payments recorded with their own method/label.

-- 1. every business gets an "Other" method; new businesses too
insert into public.payment_methods (business_id, name, kind, sort)
select b.id, 'Other', 'other', 9 from public.businesses b
on conflict (business_id, name) do nothing;

create or replace function public.add_other_payment_method() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into payment_methods (business_id, name, kind, sort) values (new.id, 'Other', 'other', 9)
  on conflict (business_id, name) do nothing;
  return new;
end $$;
drop trigger if exists businesses_other_method on public.businesses;
create trigger businesses_other_method after insert on public.businesses
  for each row execute function public.add_other_payment_method();

-- 2. finalize_sale: payments may carry a label; "Other" needs one.
--    (same as 0003 otherwise)
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
      if v_method.name = 'Other' and coalesce(trim(v_pay->>'label'), '') = '' then
        raise exception 'Say what the "Other" payment was (for example Bank transfer)';
      end if;
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
      values (v_sale, v_b, v_method.id,
              case when v_method.kind = 'other' and coalesce(trim(v_pay->>'label'), '') <> '' then left(trim(v_pay->>'label'), 40) else v_method.name end,
              round((v_pay->>'amount')::numeric, 2),
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

-- 3. later payments (partial payment completed on another day)
drop function if exists public.add_payment(uuid, uuid, numeric, text);
create or replace function public.add_payment(p_sale uuid, p_method uuid, p_amount numeric, p_reference text default null, p_label text default null)
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
  if v_method.name = 'Other' and coalesce(trim(p_label), '') = '' then
    raise exception 'Say what the "Other" payment was (for example Bank transfer)';
  end if;
  insert into payments (sale_id, business_id, method_id, method_name, amount, reference, received_by)
  values (p_sale, v.business_id, p_method,
          case when v_method.kind = 'other' and coalesce(trim(p_label), '') <> '' then left(trim(p_label), 40) else v_method.name end,
          v_amt, nullif(trim(p_reference),''), auth.uid());
  update sales set amount_paid = amount_paid + v_amt, balance_due = balance_due - v_amt,
    payment_status = case when balance_due - v_amt = 0 then 'paid' else 'partial' end
  where id = p_sale;
  perform audit(v.business_id, 'payment_added', 'sale', p_sale, jsonb_build_object('amount', v_amt, 'method', v_method.name));
end $$;
revoke all on function public.add_payment(uuid, uuid, numeric, text, text) from public, anon;
grant execute on function public.add_payment(uuid, uuid, numeric, text, text) to authenticated;

notify pgrst, 'reload schema';
