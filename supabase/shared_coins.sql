-- Run this SQL in the SAME Supabase project used by SparkArt.
-- It uses the existing public.user_tickets table and creates two RPC functions
-- for checkoutcoins2.win:
--   - get_user_tickets_shared
--   - consume_user_tickets_shared

create or replace function public.get_user_tickets_shared(
  p_user_id uuid,
  p_email text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(trim(p_email));
  v_row public.user_tickets%rowtype;
begin
  if p_user_id is null then
    raise exception 'invalid_user_id';
  end if;
  if v_email is null or v_email = '' then
    raise exception 'invalid_email';
  end if;

  select * into v_row
  from public.user_tickets
  where user_id = p_user_id
  for update;

  if not found then
    select * into v_row
    from public.user_tickets
    where email = v_email
    for update;

    if found then
      if v_row.user_id is distinct from p_user_id then
        update public.user_tickets
        set user_id = p_user_id, email = v_email
        where id = v_row.id
        returning * into v_row;
      end if;
    else
      insert into public.user_tickets(email, user_id, tickets)
      values (v_email, p_user_id, 0)
      returning * into v_row;
    end if;
  end if;

  return jsonb_build_object(
    'tickets', v_row.tickets,
    'email', v_row.email
  );
end;
$$;

create or replace function public.consume_user_tickets_shared(
  p_user_id uuid,
  p_email text,
  p_cost integer,
  p_reason text default 'game_play'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.user_tickets%rowtype;
  v_after integer;
  v_email text := lower(trim(p_email));
  v_reason text := left(coalesce(p_reason, 'game_play'), 120);
begin
  if p_user_id is null then
    raise exception 'invalid_user_id';
  end if;
  if v_email is null or v_email = '' then
    raise exception 'invalid_email';
  end if;
  if p_cost is null or p_cost <= 0 then
    raise exception 'invalid_cost';
  end if;

  perform public.get_user_tickets_shared(p_user_id, v_email);

  select * into v_row
  from public.user_tickets
  where user_id = p_user_id
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'tickets', 0);
  end if;

  if v_row.tickets < p_cost then
    return jsonb_build_object('ok', false, 'tickets', v_row.tickets);
  end if;

  update public.user_tickets
  set
    tickets = tickets - p_cost,
    updated_at = now()
  where id = v_row.id
  returning tickets into v_after;

  if to_regclass('public.ticket_events') is not null then
    insert into public.ticket_events(
      usage_id,
      email,
      user_id,
      delta,
      reason,
      metadata
    )
    values (
      gen_random_uuid()::text,
      v_email,
      p_user_id,
      -p_cost,
      v_reason,
      jsonb_build_object('source', 'checkoutcoins2')
    )
    on conflict (usage_id) do nothing;
  end if;

  return jsonb_build_object('ok', true, 'tickets', v_after);
end;
$$;

grant execute on function public.get_user_tickets_shared(uuid, text) to authenticated, service_role;
grant execute on function public.consume_user_tickets_shared(uuid, text, integer, text) to authenticated, service_role;
