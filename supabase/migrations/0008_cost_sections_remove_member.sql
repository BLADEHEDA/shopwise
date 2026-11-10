-- 0008: financial access per section (optional), and removing a team member.

-- 1. Financial access can be limited to some of a person's sections.
--    null = all the sections they work in (the old behaviour).
alter table public.memberships add column if not exists cost_section_ids uuid[];
alter table public.invitations add column if not exists cost_section_ids uuid[];

create or replace function public.can_view_costs(b uuid, s uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from memberships m
    where m.business_id = b and m.user_id = auth.uid() and m.active
      and (m.role = 'owner'
           or (m.role in ('section_owner','manager','accountant') and m.can_view_costs
               and public.has_section(b, s)
               and (m.cost_section_ids is null or s = any(m.cost_section_ids)))))
$$;

-- set it on a member (super admin only); null = all their sections
create or replace function public.set_member_cost_sections(p_membership uuid, p_section_ids uuid[])
returns void language plpgsql security definer set search_path = public as $$
declare v memberships;
begin
  select * into v from memberships where id = p_membership for update;
  if not found or not is_owner(v.business_id) then raise exception 'Only a super admin can change financial access'; end if;
  if exists (select 1 from unnest(coalesce(p_section_ids,'{}')) sid
             where not exists (select 1 from sections where id = sid and business_id = v.business_id)) then
    raise exception 'Section does not belong to this business';
  end if;
  update memberships set cost_section_ids = case when v.role = 'owner' then null else p_section_ids end where id = p_membership;
  perform audit(v.business_id, 'member_cost_sections', 'membership', p_membership,
    jsonb_build_object('before', v.cost_section_ids, 'after', p_section_ids));
end $$;
revoke all on function public.set_member_cost_sections(uuid, uuid[]) from public, anon;
grant execute on function public.set_member_cost_sections(uuid, uuid[]) to authenticated;

-- same for a pending invitation (by its token, as returned by create_invitation)
create or replace function public.set_invitation_cost_sections(p_token uuid, p_section_ids uuid[])
returns void language plpgsql security definer set search_path = public as $$
declare v invitations;
begin
  select * into v from invitations where token = p_token for update;
  if not found or not is_owner(v.business_id) then raise exception 'Only a super admin can change financial access'; end if;
  if v.accepted_at is not null then raise exception 'This invitation has already been used'; end if;
  update invitations set cost_section_ids = p_section_ids where id = v.id;
end $$;
revoke all on function public.set_invitation_cost_sections(uuid, uuid[]) from public, anon;
grant execute on function public.set_invitation_cost_sections(uuid, uuid[]) to authenticated;

-- accept_invitation: also copy the financial sections (same as 0001 otherwise)
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
  insert into memberships (business_id, user_id, role, all_sections, can_view_costs, cost_section_ids, active)
  values (v.business_id, auth.uid(), v.role, v.all_sections, v.can_view_costs, v.cost_section_ids, true)
  on conflict (business_id, user_id) do update
    set role = excluded.role, all_sections = excluded.all_sections,
        can_view_costs = excluded.can_view_costs, cost_section_ids = excluded.cost_section_ids, active = true
  returning id into v_m;
  delete from membership_sections where membership_id = v_m;
  insert into membership_sections (membership_id, section_id, business_id)
    select v_m, sid, v.business_id from unnest(v.section_ids) sid;
  update invitations set accepted_at = now() where id = v.id;
  perform audit(v.business_id, 'invitation_accepted', 'membership', v_m, jsonb_build_object('role', v.role));
  return v.business_id;
end $$;

-- 2. Remove someone from the shop. Their past sales, shifts and logs stay
--    (history is never deleted). A super admin can never be removed this way,
--    and nobody can remove themselves.
create or replace function public.remove_member(p_membership uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v memberships; v_name text;
begin
  select * into v from memberships where id = p_membership for update;
  if not found or not is_owner(v.business_id) then raise exception 'Only a super admin can remove people'; end if;
  if v.user_id = auth.uid() then raise exception 'You can''t remove your own account'; end if;
  if v.role = 'owner' then raise exception 'A super admin account can''t be removed'; end if;
  if exists (select 1 from demo_accounts d where d.user_id = v.user_id) then
    raise exception 'Demo accounts can''t be removed (they are shared by all testers)';
  end if;
  select coalesce(full_name, email) into v_name from profiles where user_id = v.user_id;
  update shifts set ended_at = now(), closed_by = auth.uid(), note = coalesce(note,'') || ' [closed: removed from shop]'
  where business_id = v.business_id and user_id = v.user_id and ended_at is null;
  delete from memberships where id = p_membership;
  perform audit(v.business_id, 'member_removed', 'membership', p_membership,
    jsonb_build_object('name', v_name, 'role', v.role, 'before', to_jsonb(v)));
end $$;
revoke all on function public.remove_member(uuid) from public, anon;
grant execute on function public.remove_member(uuid) to authenticated;

-- 3. Names for the audit log, including people who have since left the shop.
create or replace function public.audit_actors(p_business uuid)
returns table (user_id uuid, name text, role text)
language sql stable security definer set search_path = public as $$
  select a.actor_id, coalesce(p.full_name, p.email, 'Unknown'), m.role
  from (select distinct actor_id from audit_log where business_id = p_business and actor_id is not null) a
  left join profiles p on p.user_id = a.actor_id
  left join memberships m on m.business_id = p_business and m.user_id = a.actor_id
  where public.is_owner(p_business)
$$;
revoke all on function public.audit_actors(uuid) from public, anon;
grant execute on function public.audit_actors(uuid) to authenticated;

notify pgrst, 'reload schema';
