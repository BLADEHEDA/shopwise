-- Shopwise 0004: in-app feedback, and an optional, isolated demo shop for testers.
-- Safe to run more than once. The demo is NOT created by this file:
--   select demo_reset();    -- create or reset the Demo Shop + demo logins
--   select demo_remove();   -- delete the demo completely (before real launch)

-- ---------------------------------------------------------------- feedback
create table if not exists public.feedback (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references public.profiles(user_id) on delete set null,
  business_id uuid references public.businesses(id) on delete set null,
  kind        text not null default 'idea' check (kind in ('bug','idea','confusing','praise')),
  message     text not null check (length(trim(message)) between 3 and 4000),
  page        text,
  device      text,
  status      text not null default 'new' check (status in ('new','done')),
  created_at  timestamptz not null default now()
);
alter table public.feedback add column if not exists author text;
alter table public.feedback enable row level security;
grant select on public.feedback to authenticated;
drop policy if exists feedback_select on public.feedback;
create policy feedback_select on public.feedback for select using (user_id = auth.uid() or public.is_platform_admin());

create or replace function public.submit_feedback(p_kind text, p_message text, p_page text, p_device text, p_business uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'Please sign in first'; end if;
  if (select count(*) from feedback where user_id = auth.uid() and created_at > now() - interval '1 hour') >= 30 then
    raise exception 'Thanks! That''s a lot of feedback in one hour. Please try again a bit later';
  end if;
  insert into feedback (user_id, business_id, kind, message, page, device, author)
  values (auth.uid(), case when is_member(p_business) then p_business end, coalesce(p_kind, 'idea'), trim(p_message),
          left(p_page, 300), left(p_device, 300),
          (select coalesce(nullif(full_name, ''), email) || coalesce(' · ' || (select b.name from businesses b where b.id = p_business and is_member(p_business)), '')
             from profiles where user_id = auth.uid()))
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.set_feedback_status(p_id uuid, p_status text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_platform_admin() then raise exception 'Not allowed'; end if;
  update feedback set status = p_status where id = p_id;
end $$;
grant execute on function public.submit_feedback(text, text, text, text, uuid), public.set_feedback_status(uuid, text) to authenticated;

-- ---------------------------------------------------------------- demo infrastructure
alter table public.businesses add column if not exists is_demo boolean not null default false;

create table if not exists public.demo_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email   text not null unique,
  label   text not null,
  sort    int not null default 0
);
create table if not exists public.demo_config (
  id       int primary key default 1 check (id = 1),
  enabled  boolean not null default false,
  password text not null default 'ShopwiseDemo1',
  reset_at timestamptz
);
insert into public.demo_config (id) values (1) on conflict do nothing;
alter table public.demo_accounts enable row level security;
alter table public.demo_config enable row level security;
revoke all on public.demo_accounts, public.demo_config from anon, authenticated;

-- Public: what the login page shows ("Try the demo" buttons).
create or replace function public.demo_info() returns jsonb
language sql stable security definer set search_path = public as $$
  select case when c.enabled then jsonb_build_object('password', c.password, 'reset_at', c.reset_at,
           'accounts', coalesce((select jsonb_agg(jsonb_build_object('email', d.email, 'label', d.label) order by d.sort) from demo_accounts d), '[]'))
         else null end
  from demo_config c where c.id = 1
$$;
grant execute on function public.demo_info() to anon, authenticated;

-- Shared demo logins can't change their email or password (testers can't lock each other out).
create or replace function public.guard_demo_accounts() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(current_setting('shopwise.demo_admin', true), '') = 'on' then return new; end if;
  if exists (select 1 from public.demo_accounts d where d.user_id = old.id) then
    if new.encrypted_password is distinct from old.encrypted_password
       or new.email is distinct from old.email
       or coalesce(new.email_change, '') <> coalesce(old.email_change, '') then
      raise exception 'Demo accounts can''t change their email or password';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists guard_demo_accounts on auth.users;
create trigger guard_demo_accounts before update on auth.users
  for each row execute function public.guard_demo_accounts();

-- Owners of the demo shop can't disable or demote the shared demo logins.
create or replace function public.update_member(
  p_membership uuid, p_role text, p_all_sections boolean, p_section_ids uuid[], p_can_view_costs boolean, p_active boolean)
returns void language plpgsql security definer set search_path = public as $$
declare v memberships; v_after jsonb;
begin
  select * into v from memberships where id = p_membership for update;
  if not found or not is_owner(v.business_id) then raise exception 'Only a super admin can change roles'; end if;
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


-- ---------------------------------------------------------------- demo builder
create or replace function public.demo_user(p_email text, p_name text, p_password text, p_label text, p_sort int)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare v_id uuid;
begin
  select id into v_id from auth.users where email = p_email;
  if v_id is null then
    v_id := gen_random_uuid();
    insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                            raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                            confirmation_token, recovery_token, email_change_token_new, email_change)
    values ('00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', p_email,
            crypt(p_password, gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}',
            jsonb_build_object('full_name', p_name), now(), now(), '', '', '', '');
    insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    values (v_id::text, v_id, jsonb_build_object('sub', v_id::text, 'email', p_email, 'email_verified', true), 'email', now(), now(), now());
  else
    update auth.users set encrypted_password = crypt(p_password, gen_salt('bf')), email_confirmed_at = coalesce(email_confirmed_at, now()),
      email_change = '', email_change_token_new = '', raw_user_meta_data = raw_user_meta_data || jsonb_build_object('full_name', p_name)
    where id = v_id;
  end if;
  insert into public.profiles (user_id, email, full_name) values (v_id, p_email, p_name)
  on conflict (user_id) do update set full_name = excluded.full_name, email = excluded.email;
  insert into public.demo_accounts (user_id, email, label, sort) values (v_id, p_email, p_label, p_sort)
  on conflict (user_id) do update set label = excluded.label, sort = excluded.sort;
  return v_id;
end $$;

create or replace function public.demo_as(p_user uuid) returns void
language sql security definer set search_path = public as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$$;

create or replace function public.demo_reset() returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_pw text; v_admin uuid; v_owner uuid; v_keeper uuid; v_b uuid; v_phones uuid; v_acc uuid;
  v_cash uuid; v_mtn uuid; v_om uuid; v_ids uuid[]; v_shift uuid; v_day int; n int; k int;
  v_prod products; v_price numeric; v_qty int; v_total numeric; v_paid numeric; v_res jsonb; v_sales int := 0;
  v_method uuid; v_seller uuid; v_sale uuid; v_pick uuid;
begin
  perform set_config('shopwise.demo_admin', 'on', true);
  perform setseed(0.42);
  select password into v_pw from demo_config where id = 1;

  -- wipe the previous demo shop (everything cascades from the business)
  delete from businesses where is_demo;

  v_admin  := demo_user('demo.admin@example.com',      'Demo Super Admin', v_pw, 'Super admin', 1);
  v_owner  := demo_user('demo.shopowner@example.com',  'Demo Shop Owner',  v_pw, 'Shop owner (Phones section)', 2);
  v_keeper := demo_user('demo.shopkeeper@example.com', 'Demo Shopkeeper',  v_pw, 'Shopkeeper (Accessories section)', 3);
  delete from memberships where user_id in (v_admin, v_owner, v_keeper);
  delete from shifts where user_id in (v_admin, v_owner, v_keeper);

  perform demo_as(v_admin);
  v_b := create_business('Demo Shop (test data)', array['Phones & Tablets', 'Accessories'], '+237 600 000 000', 'Demo street, Buea');
  update businesses set is_demo = true, receipt_footer = 'Demo receipt: test data only' where id = v_b;
  select id into v_phones from sections where business_id = v_b and name = 'Phones & Tablets';
  select id into v_acc    from sections where business_id = v_b and name = 'Accessories';
  select id into v_cash from payment_methods where business_id = v_b and kind = 'cash';
  select id into v_mtn  from payment_methods where business_id = v_b and name = 'MTN Mobile Money';
  select id into v_om   from payment_methods where business_id = v_b and name = 'Orange Money';

  insert into memberships (business_id, user_id, role, all_sections, can_view_costs) values
    (v_b, v_owner, 'section_owner', false, true), (v_b, v_keeper, 'staff', false, false);
  insert into membership_sections (membership_id, section_id, business_id)
    select id, v_phones, v_b from memberships where business_id = v_b and user_id = v_owner
    union all select id, v_acc, v_b from memberships where business_id = v_b and user_id = v_keeper;

  -- catalogue (two items deliberately without a selling price)
  v_res := import_products(v_b, '[
    {"section":"Accessories","category":"Audio","name":"Oraimo FreePods Lite earbuds","brand":"Oraimo","unit_cost":"7000","target_price":"12000","min_price":"10000","opening_stock":"15"},
    {"section":"Accessories","category":"Audio","name":"JBL Go 3 speaker","brand":"JBL","unit_cost":"14000","target_price":"22000","min_price":"19000","opening_stock":"6"},
    {"section":"Accessories","category":"Chargers","name":"20W USB-C fast charger","unit_cost":"2800","target_price":"5000","min_price":"4000","opening_stock":"25"},
    {"section":"Accessories","category":"Chargers","name":"65W universal laptop charger","unit_cost":"6500","target_price":"11000","min_price":"9500","opening_stock":"4"},
    {"section":"Accessories","category":"Chargers","name":"Power bank 20000mAh","unit_cost":"7500","target_price":"13000","min_price":"11000","opening_stock":"3","low_stock_threshold":"3"},
    {"section":"Accessories","category":"Cables","name":"USB-C cable 1m","unit_cost":"600","target_price":"1500","min_price":"1000","opening_stock":"40","low_stock_threshold":"10"},
    {"section":"Accessories","category":"Cables","name":"iPhone Lightning cable","unit_cost":"700","target_price":"1500","min_price":"1200","opening_stock":"5","low_stock_threshold":"5"},
    {"section":"Accessories","category":"Cables","name":"HDMI cable 1.5m","unit_cost":"900","target_price":"2000","min_price":"1500","opening_stock":"12"},
    {"section":"Accessories","category":"Cases","name":"Phone case (assorted)","unit_cost":"800","target_price":"2500","min_price":"2000","opening_stock":"30"},
    {"section":"Accessories","category":"Cases","name":"Tempered glass screen protector","unit_cost":"300","target_price":"1000","min_price":"700","opening_stock":"60","low_stock_threshold":"10"},
    {"section":"Accessories","category":"Wearables","name":"Smart watch fitness band","unit_cost":"6000","target_price":"12000","min_price":"10000","opening_stock":"0","low_stock_threshold":"2"},
    {"section":"Accessories","category":"Storage","name":"32GB memory card","unit_cost":"2500","target_price":"4500","min_price":"4000","opening_stock":"10"},
    {"section":"Accessories","category":"Storage","name":"64GB USB flash drive","unit_cost":"3500","target_price":"6000","min_price":"5000","opening_stock":"8"},
    {"section":"Accessories","category":"Accessories","name":"Ring light 10 inch","unit_cost":"5000","opening_stock":"3"},
    {"section":"Phones & Tablets","category":"Phones","name":"Itel A70","variant_label":"64GB","brand":"Itel","unit_cost":"42000","target_price":"55000","min_price":"50000","opening_stock":"5","low_stock_threshold":"2"},
    {"section":"Phones & Tablets","category":"Phones","name":"Tecno Spark 20","variant_label":"128GB","brand":"Tecno","unit_cost":"68000","target_price":"85000","min_price":"80000","opening_stock":"4","low_stock_threshold":"2"},
    {"section":"Phones & Tablets","category":"Phones","name":"Samsung Galaxy A15","variant_label":"128GB","brand":"Samsung","unit_cost":"82000","target_price":"99000","min_price":"94000","opening_stock":"3","low_stock_threshold":"1"},
    {"section":"Phones & Tablets","category":"Phones","name":"Infinix Hot 40i","variant_label":"128GB","brand":"Infinix","unit_cost":"60000","target_price":"75000","min_price":"70000","opening_stock":"4","low_stock_threshold":"2"},
    {"section":"Phones & Tablets","category":"Tablets","name":"Redmi Pad SE tablet","brand":"Xiaomi","unit_cost":"95000","opening_stock":"1"}
  ]'::jsonb, 'skip', null);
  if not (v_res->>'ok')::boolean then raise exception 'Demo catalogue failed: %', v_res->'errors'; end if;

  -- an imported batch from China with freight (shows landed cost)
  perform receive_purchase(jsonb_build_object('business_id', v_b, 'section_id', v_acc, 'supplier_name', 'Guangzhou Audio Wholesale (demo)',
    'supplier_country', 'China', 'source', 'import', 'currency', 'CNY', 'exchange_rate', '86', 'freight_cost', '15000', 'other_costs', '5000',
    'allocation_method', 'value', 'reference', 'DEMO-ALB-001',
    'lines', jsonb_build_array(
      jsonb_build_object('product_id', (select id from products where business_id = v_b and name = 'Oraimo FreePods Lite earbuds'), 'quantity', 10, 'unit_price', '75'),
      jsonb_build_object('product_id', (select id from products where business_id = v_b and name = 'USB-C cable 1m'), 'quantity', 50, 'unit_price', '6'))));

  -- a week of sales, one shift per seller per day (today's shifts stay open)
  for v_day in reverse 6..0 loop
    foreach v_seller in array array[v_keeper, v_owner] loop
      perform demo_as(v_seller);
      v_shift := clock_in(v_b);
      select array_agg(id) into v_ids from products
       where business_id = v_b and target_price is not null and stock_qty > 0
         and section_id = case when v_seller = v_keeper then v_acc else v_phones end;
      n := case when v_seller = v_keeper then 2 + floor(random() * 4)::int else (case when random() < 0.5 then 1 else 0 end) end;
      for k in 1..n loop
        if v_ids is null then exit; end if;
        v_pick := v_ids[1 + floor(random() * array_length(v_ids, 1))::int];   -- pick first: random() in WHERE runs per row
        select * into v_prod from products where id = v_pick;
        v_qty := case when v_prod.target_price < 3000 then 1 + floor(random() * 3)::int else 1 end;
        if v_prod.stock_qty < v_qty then continue; end if;
        -- negotiated price between minimum and target, rounded to 500
        v_price := greatest(v_prod.min_price, round((v_prod.min_price + random() * (v_prod.target_price - v_prod.min_price)) / 500) * 500);
        v_total := v_price * v_qty;
        v_paid := case when random() < 0.12 then round(v_total * 0.5 / 500) * 500 else v_total end;
        v_method := case when random() < 0.5 then v_cash when random() < 0.6 then v_mtn else v_om end;
        v_res := finalize_sale(jsonb_build_object('business_id', v_b, 'client_tx_id', gen_random_uuid(),
          'customer_name', case when v_paid < v_total then (array['Mr. Fon','Mrs. Eyong','Brenda','Tabi'])[1 + floor(random()*4)::int] end,
          'customer_phone', case when v_paid < v_total then '6' || lpad((floor(random() * 99999999))::text, 8, '0') end,
          'lines', jsonb_build_array(jsonb_build_object('product_id', v_prod.id, 'quantity', v_qty, 'unit_price', v_price)),
          'payments', case when v_paid > 0 then jsonb_build_array(jsonb_build_object('method_id', v_method, 'amount', v_paid,
                             'reference', case when v_method <> v_cash then 'DEMO' || floor(random() * 1e6)::text end)) else '[]'::jsonb end));
        v_sales := v_sales + 1;
        v_sale := (v_res->>'sale_id')::uuid;
        if v_day > 0 then
          update sales set sold_at = sold_at - make_interval(days => v_day) + make_interval(mins => k * 37) where id = v_sale;
          update payments set created_at = created_at - make_interval(days => v_day) + make_interval(mins => k * 37) where sale_id = v_sale;
          update stock_movements set created_at = created_at - make_interval(days => v_day) where ref_id = v_sale;
        end if;
      end loop;
      if v_day > 0 then
        perform clock_out(v_shift, null, null);
        update shifts set started_at = started_at - make_interval(days => v_day) - interval '30 minutes',
                          ended_at = ended_at - make_interval(days => v_day) + interval '8 hours'
        where id = v_shift;
      end if;
    end loop;
  end loop;

  -- things waiting for the super admin / shop owner
  perform demo_as(v_keeper);
  perform request_price_override(v_b, (select id from products where business_id = v_b and name = 'JBL Go 3 speaker'), 17500, 1, 'Customer is buying two items and paying cash');
  perform submit_expense(v_b, v_acc, 'Transport', 2500, current_date, 'Taxi to collect stock from Mile 17 (demo)', 'Cash', null);
  perform flag_stock((select id from products where business_id = v_b and name = 'iPhone Lightning cable'), 'low', 'Only 2 left on the shelf');
  -- an offline sale that sold more than was in stock -> needs review
  v_res := finalize_sale(jsonb_build_object('business_id', v_b, 'client_tx_id', gen_random_uuid(), 'offline', true, 'sold_at', now() - interval '20 minutes',
    'lines', jsonb_build_array(jsonb_build_object('product_id', (select id from products where business_id = v_b and name = 'Power bank 20000mAh'), 'quantity', 4, 'unit_price', '13000')),
    'payments', jsonb_build_array(jsonb_build_object('method_id', v_cash, 'amount', '52000'))));
  perform demo_as(v_admin);
  perform submit_expense(v_b, null, 'Rent', 50000, date_trunc('month', current_date)::date, 'Shop rent (demo)', 'MTN Mobile Money', null);
  perform submit_expense(v_b, null, 'Electricity', 12000, current_date - 3, 'ENEO bill (demo)', 'Orange Money', null);

  update demo_config set enabled = true, reset_at = now() where id = 1;
  perform set_config('request.jwt.claims', '', true);
  return jsonb_build_object('business_id', v_b, 'sales', v_sales,
    'logins', (select jsonb_agg(email order by sort) from demo_accounts), 'password', v_pw);
end $$;

create or replace function public.demo_remove() returns void
language plpgsql security definer set search_path = public as $$
begin
  perform set_config('shopwise.demo_admin', 'on', true);
  delete from businesses where is_demo;
  delete from auth.users where id in (select user_id from demo_accounts);
  delete from demo_accounts;
  update demo_config set enabled = false where id = 1;
end $$;

-- The super admin can reset the demo from Settings (platform admins only).
create or replace function public.demo_reset_by_admin() returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not is_platform_admin() then raise exception 'Only a platform administrator can reset the demo'; end if;
  return demo_reset();
end $$;

revoke all on function public.demo_user(text, text, text, text, int), public.demo_as(uuid), public.demo_reset(), public.demo_remove()
  from public, anon, authenticated;
grant execute on function public.demo_reset_by_admin() to authenticated;

-- refresh the API's function list
notify pgrst, 'reload schema';
