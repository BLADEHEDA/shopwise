-- Shopwise 0002: keep profiles.email in sync when a user changes their login email.
-- Safe to run more than once.
create or replace function public.handle_user_email_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.email is distinct from old.email then
    update public.profiles set email = lower(new.email) where user_id = new.id;
  end if;
  return new;
end $$;

-- only create it if missing (dropping a trigger on auth.users needs more rights
-- than the deploy connection may have; the function above is replaced anyway)
do $t$ begin
  if not exists (select 1 from pg_trigger where tgname = 'on_auth_user_email_changed' and tgrelid = 'auth.users'::regclass) then
    create trigger on_auth_user_email_changed after update of email on auth.users
  for each row execute function public.handle_user_email_change();
  end if;
exception when insufficient_privilege then
  raise warning 'could not add a trigger on auth.users (%); run this file once in the Supabase SQL editor', sqlerrm;
end $t$;

-- refresh the API's function list
notify pgrst, 'reload schema';
