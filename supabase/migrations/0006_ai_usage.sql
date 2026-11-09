-- Shopwise 0006: usage log + daily limit for "smart reading" (AI reading of
-- photos, scans and messy files). Protects the platform's AI bill.
-- Safe to run more than once.
create table if not exists public.ai_usage (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid references public.businesses(id) on delete set null,
  user_id       uuid references public.profiles(user_id) on delete set null,
  kind          text not null default 'import',
  file_name     text,
  pages         int,
  input_tokens  int,
  output_tokens int,
  products      int,
  ok            boolean,
  error         text,
  created_at    timestamptz not null default now(),
  finished_at   timestamptz
);
create index if not exists ai_usage_business_idx on public.ai_usage (business_id, created_at desc);
alter table public.ai_usage enable row level security;
grant select on public.ai_usage to authenticated;
drop policy if exists ai_usage_select on public.ai_usage;
create policy ai_usage_select on public.ai_usage for select using (public.is_owner(business_id) or public.is_platform_admin());

create table if not exists public.ai_settings (
  id                     int primary key default 1 check (id = 1),
  daily_limit_business   int not null default 40,
  daily_limit_demo       int not null default 15
);
insert into public.ai_settings (id) values (1) on conflict do nothing;
alter table public.ai_settings enable row level security;
revoke all on public.ai_settings from anon, authenticated;

-- Called by the server before each AI reading. Checks the user may import
-- products in this business and that today's limit is not reached.
create or replace function public.begin_ai_import(p_business uuid, p_file text, p_pages int default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_used int; v_limit int; v_demo boolean;
begin
  if my_role(p_business) not in ('owner','section_owner','manager') then
    raise exception 'Only a super admin, shop owner or manager can import products';
  end if;
  select is_demo into v_demo from businesses where id = p_business;
  select case when v_demo then daily_limit_demo else daily_limit_business end into v_limit from ai_settings where id = 1;
  select count(*) into v_used from ai_usage where business_id = p_business and created_at > now() - interval '24 hours';
  if v_used >= v_limit then
    raise exception 'Daily limit for smart reading reached (% files in 24 hours). Try again tomorrow, or upload an Excel/CSV file', v_limit;
  end if;
  insert into ai_usage (business_id, user_id, file_name, pages) values (p_business, auth.uid(), left(p_file, 200), p_pages)
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.finish_ai_import(p_id uuid, p_ok boolean, p_input int, p_output int, p_products int, p_error text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  update ai_usage set ok = p_ok, input_tokens = p_input, output_tokens = p_output, products = p_products,
    error = left(p_error, 500), finished_at = now()
  where id = p_id and user_id = auth.uid() and finished_at is null;
end $$;
grant execute on function public.begin_ai_import(uuid, text, int), public.finish_ai_import(uuid, boolean, int, int, int, text) to authenticated;

notify pgrst, 'reload schema';
