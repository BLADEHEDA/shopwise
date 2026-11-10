-- 0009: one super admin per business (co-owners are Shop owners, optionally
-- allowed to manage the team), payment proof screenshots, sales kept as
-- drafts across tabs/devices, readable audit log.

create or replace function public.shopwise_schema() returns int language sql immutable as $$ select 9 $$;
grant execute on function public.shopwise_schema() to anon, authenticated;

-- 1. team management by trusted shop owners -------------------------------
alter table public.memberships add column if not exists can_manage_team boolean not null default false;
alter table public.invitations add column if not exists can_manage_team boolean not null default false;

create or replace function public.can_manage_team(b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from memberships m where m.business_id = b and m.user_id = auth.uid() and m.active
                 and (m.role = 'owner' or (m.role in ('section_owner','manager') and m.can_manage_team)))
$$;
grant execute on function public.can_manage_team(uuid) to authenticated;

drop policy if exists invitations_select on public.invitations;
create policy invitations_select on public.invitations for select using (public.can_manage_team(business_id));

create or replace function public.create_invitation(
  p_business uuid, p_email text, p_role text, p_all_sections boolean, p_section_ids uuid[], p_can_view_costs boolean,
  p_phone text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_token uuid; v_id uuid;
begin
  if not can_manage_team(p_business) then raise exception 'Only the super admin, or a shop owner allowed to manage the team, can invite people'; end if;
  if p_role = 'owner' then
    raise exception 'A business has only one super admin (the person who created it). Invite them as Shop owner with all sections and financial access instead';
  end if;
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

create or replace function public.update_member(
  p_membership uuid, p_role text, p_all_sections boolean, p_section_ids uuid[], p_can_view_costs boolean, p_active boolean)
returns void language plpgsql security definer set search_path = public as $$
declare v memberships; v_after jsonb;
begin
  select * into v from memberships where id = p_membership for update;
  if not found or not can_manage_team(v.business_id) then raise exception 'Only the super admin, or a shop owner allowed to manage the team, can change roles'; end if;
  if v.role = 'owner' and not is_owner(v.business_id) then raise exception 'Only the super admin can change the super admin account'; end if;
  if v.user_id = auth.uid() and not is_owner(v.business_id) then raise exception 'You can''t change your own access. Ask the super admin'; end if;
  if p_role = 'owner' and v.role <> 'owner' then
    raise exception 'A business has only one super admin. Give them the Shop owner role with all sections and financial access instead';
  end if;
  if exists (select 1 from demo_accounts d where d.user_id = v.user_id) then
    raise exception 'Demo accounts can''t be changed (they are shared by all testers)';
  end if;
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

-- only the super admin decides who may manage the team
create or replace function public.set_team_access(p_membership uuid, p_allowed boolean)
returns void language plpgsql security definer set search_path = public as $$
declare v memberships;
begin
  select * into v from memberships where id = p_membership for update;
  if not found or not is_owner(v.business_id) then raise exception 'Only the super admin can decide who manages the team'; end if;
  if v.role not in ('section_owner','manager') then
    update memberships set can_manage_team = false where id = p_membership; return;
  end if;
  update memberships set can_manage_team = coalesce(p_allowed, false) where id = p_membership;
  if v.can_manage_team is distinct from coalesce(p_allowed, false) then
    perform audit(v.business_id, 'member_team_access', 'membership', p_membership, jsonb_build_object('allowed', coalesce(p_allowed,false)));
  end if;
end $$;
revoke all on function public.set_team_access(uuid, boolean) from public, anon;
grant execute on function public.set_team_access(uuid, boolean) to authenticated;

create or replace function public.set_invitation_team_access(p_token uuid, p_allowed boolean)
returns void language plpgsql security definer set search_path = public as $$
declare v invitations;
begin
  select * into v from invitations where token = p_token for update;
  if not found or not is_owner(v.business_id) then raise exception 'Only the super admin can decide who manages the team'; end if;
  update invitations set can_manage_team = coalesce(p_allowed,false) and role in ('section_owner','manager') where id = v.id;
end $$;
revoke all on function public.set_invitation_team_access(uuid, boolean) from public, anon;
grant execute on function public.set_invitation_team_access(uuid, boolean) to authenticated;

create or replace function public.set_member_cost_sections(p_membership uuid, p_section_ids uuid[])
returns void language plpgsql security definer set search_path = public as $$
declare v memberships;
begin
  select * into v from memberships where id = p_membership for update;
  if not found or not can_manage_team(v.business_id) then raise exception 'You are not allowed to change financial access'; end if;
  if v.role = 'owner' then return; end if;
  if v.user_id = auth.uid() and not is_owner(v.business_id) then raise exception 'You can''t change your own access. Ask the super admin'; end if;
  if exists (select 1 from unnest(coalesce(p_section_ids,'{}')) sid
             where not exists (select 1 from sections where id = sid and business_id = v.business_id)) then
    raise exception 'Section does not belong to this business';
  end if;
  update memberships set cost_section_ids = p_section_ids where id = p_membership;
  if v.cost_section_ids is distinct from p_section_ids then
    perform audit(v.business_id, 'member_cost_sections', 'membership', p_membership,
      jsonb_build_object('before', v.cost_section_ids, 'after', p_section_ids));
  end if;
end $$;

create or replace function public.set_invitation_cost_sections(p_token uuid, p_section_ids uuid[])
returns void language plpgsql security definer set search_path = public as $$
declare v invitations;
begin
  select * into v from invitations where token = p_token for update;
  if not found or not can_manage_team(v.business_id) then raise exception 'You are not allowed to change financial access'; end if;
  if v.accepted_at is not null then raise exception 'This invitation has already been used'; end if;
  update invitations set cost_section_ids = p_section_ids where id = v.id;
end $$;

create or replace function public.revoke_invitation(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v invitations;
begin
  select * into v from invitations where id = p_id;
  if not found or not can_manage_team(v.business_id) then raise exception 'Not allowed'; end if;
  update invitations set revoked_at = now() where id = p_id;
  perform audit(v.business_id, 'invitation_revoked', 'invitation', p_id, jsonb_build_object('email', v.email, 'role', v.role));
end $$;

create or replace function public.remove_member(p_membership uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v memberships; v_name text;
begin
  select * into v from memberships where id = p_membership for update;
  if not found or not can_manage_team(v.business_id) then raise exception 'You are not allowed to remove people'; end if;
  if v.user_id = auth.uid() then raise exception 'You can''t remove your own account'; end if;
  if v.role = 'owner' then raise exception 'The super admin can never be removed'; end if;
  if exists (select 1 from demo_accounts d where d.user_id = v.user_id) then
    raise exception 'Demo accounts can''t be removed (they are shared by all testers)';
  end if;
  select coalesce(full_name, email) into v_name from profiles where user_id = v.user_id;
  update shifts set ended_at = now(), closed_by = auth.uid(), note = coalesce(note,'') || ' [closed: removed from shop]'
  where business_id = v.business_id and user_id = v.user_id and ended_at is null;
  delete from memberships where id = p_membership;
  perform audit(v.business_id, 'member_removed', 'membership', p_membership,
    jsonb_build_object('name', v_name, 'role', v.role));
end $$;

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
  insert into memberships (business_id, user_id, role, all_sections, can_view_costs, cost_section_ids, can_manage_team, active)
  values (v.business_id, auth.uid(), v.role, v.all_sections, v.can_view_costs, v.cost_section_ids, v.can_manage_team, true)
  on conflict (business_id, user_id) do update
    set role = excluded.role, all_sections = excluded.all_sections, can_view_costs = excluded.can_view_costs,
        cost_section_ids = excluded.cost_section_ids, can_manage_team = excluded.can_manage_team, active = true
  returning id into v_m;
  delete from membership_sections where membership_id = v_m;
  insert into membership_sections (membership_id, section_id, business_id)
    select v_m, sid, v.business_id from unnest(v.section_ids) sid;
  update invitations set accepted_at = now() where id = v.id;
  perform audit(v.business_id, 'invitation_accepted', 'membership', v_m, jsonb_build_object('role', v.role, 'email', v.email));
  return v.business_id;
end $$;

-- 2. proof of payment (screenshot) -----------------------------------------
alter table public.payments add column if not exists proof_path text;

-- folder = business id; CASE so other buckets' paths are never cast to uuid
create or replace function public.proof_folder_ok(p_name text) returns boolean
language sql stable security definer set search_path = public as $$
  select case when split_part(p_name, '/', 1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then public.is_member(split_part(p_name, '/', 1)::uuid) else false end
$$;
grant execute on function public.proof_folder_ok(text) to authenticated;

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public) values ('proofs', 'proofs', false) on conflict (id) do nothing;
    if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'proofs read') then
      execute $p$ create policy "proofs read" on storage.objects for select to authenticated using (
        bucket_id = 'proofs' and public.proof_folder_ok(name)) $p$;
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'proofs write') then
      execute $p$ create policy "proofs write" on storage.objects for insert to authenticated with check (
        bucket_id = 'proofs' and public.proof_folder_ok(name)) $p$;
    end if;
  end if;
end $$;

-- finalize_sale: payments may carry a proof screenshot (same as 0007 otherwise)
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
      insert into payments (sale_id, business_id, method_id, method_name, amount, reference, proof_path, received_by, created_at)
      values (v_sale, v_b, v_method.id,
              case when v_method.kind = 'other' and coalesce(trim(v_pay->>'label'), '') <> '' then left(trim(v_pay->>'label'), 40) else v_method.name end,
              round((v_pay->>'amount')::numeric, 2),
              nullif(trim(v_pay->>'reference'), ''), nullif(v_pay->>'proof_path', ''), v_uid, v_sold_at);
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

drop function if exists public.add_payment(uuid, uuid, numeric, text, text);
create or replace function public.add_payment(p_sale uuid, p_method uuid, p_amount numeric, p_reference text default null, p_label text default null, p_proof text default null)
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
  insert into payments (sale_id, business_id, method_id, method_name, amount, reference, proof_path, received_by)
  values (p_sale, v.business_id, p_method,
          case when v_method.kind = 'other' and coalesce(trim(p_label), '') <> '' then left(trim(p_label), 40) else v_method.name end,
          v_amt, nullif(trim(p_reference),''), nullif(p_proof,''), auth.uid());
  update sales set amount_paid = amount_paid + v_amt, balance_due = balance_due - v_amt,
    payment_status = case when balance_due - v_amt = 0 then 'paid' else 'partial' end
  where id = p_sale;
  perform audit(v.business_id, 'payment_added', 'sale', p_sale, jsonb_build_object('amount', v_amt, 'method', v_method.name, 'receipt_no', v.receipt_no));
end $$;
revoke all on function public.add_payment(uuid, uuid, numeric, text, text, text) from public, anon;
grant execute on function public.add_payment(uuid, uuid, numeric, text, text, text) to authenticated;

-- 3. a sale in progress survives tab changes, reloads and a change of phone --
create table if not exists public.pos_drafts (
  business_id uuid not null references public.businesses(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  data        jsonb not null,
  updated_at  timestamptz not null default now(),
  primary key (business_id, user_id)
);
alter table public.pos_drafts enable row level security;
drop policy if exists pos_drafts_own on public.pos_drafts;
create policy pos_drafts_own on public.pos_drafts for all to authenticated
  using (user_id = auth.uid() and public.is_member(business_id))
  with check (user_id = auth.uid() and public.is_member(business_id));
grant select, insert, update, delete on public.pos_drafts to authenticated;

-- 4. readable audit log: who (with role), and what the record is called ----
create or replace function public.audit_feed(p_business uuid, p_before bigint default null, p_limit int default 50)
returns table (id bigint, created_at timestamptz, action text, entity text, entity_id uuid, details jsonb,
               actor_name text, actor_role text, entity_label text, subject_name text)
language sql stable security definer set search_path = public as $$
  select a.id, a.created_at, a.action, a.entity, a.entity_id, a.details,
         coalesce(pa.full_name, pa.email),
         ma.role,
         case a.entity
           when 'product' then (select p.name || coalesce(' (' || p.variant_label || ')', '') from products p where p.id = a.entity_id)
           when 'sale' then (select 'receipt #' || s.receipt_no from sales s where s.id = a.entity_id)
           when 'expense' then (select coalesce(e.description, e.category) from expenses e where e.id = a.entity_id)
           when 'purchase' then (select coalesce(su.name, 'purchase') from purchases pu left join suppliers su on su.id = pu.supplier_id where pu.id = a.entity_id)
           when 'membership' then (select coalesce(pr.full_name, pr.email) from memberships m join profiles pr on pr.user_id = m.user_id where m.id = a.entity_id)
           when 'invitation' then (select i.email from invitations i where i.id = a.entity_id)
           when 'shift' then (select coalesce(pr.full_name, pr.email) from shifts sh join profiles pr on pr.user_id = sh.user_id where sh.id = a.entity_id)
         end,
         (select coalesce(pr.full_name, pr.email) from profiles pr where pr.user_id = nullif(a.details->>'staff','')::uuid)
  from audit_log a
  left join profiles pa on pa.user_id = a.actor_id
  left join memberships ma on ma.business_id = a.business_id and ma.user_id = a.actor_id
  where a.business_id = p_business and (p_before is null or a.id < p_before)
    and (public.is_owner(p_business) or public.can_manage_team(p_business))
  order by a.id desc
  limit least(coalesce(p_limit, 50), 200)
$$;
revoke all on function public.audit_feed(uuid, bigint, int) from public, anon;
grant execute on function public.audit_feed(uuid, bigint, int) to authenticated;

notify pgrst, 'reload schema';
