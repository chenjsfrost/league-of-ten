-- Server-assigned dungeon seats.
--
-- Clients used to pick their own presence id and joinedAt, so anyone could claim to be the host
-- or fill a room with fake members. Now the server hands out seats: one per account per room,
-- capped at 10, with the join time taken from the database clock. Each seat stores the public key
-- that session signs its broadcasts with, so peers can verify who sent a message.
--
-- Clients have no direct access to the table; they go through the functions below.

create table public.room_seats (
  id uuid primary key default gen_random_uuid(),
  room text not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  public_key text not null,
  joined_at timestamptz not null,
  seen_at timestamptz not null,
  unique (room, user_id)
);

create index room_seats_room_idx on public.room_seats (room, joined_at);

alter table public.room_seats enable row level security;
-- No policies on purpose: rows are only reachable through the security definer functions.

-- A seat is live while its owner keeps heartbeating. Keep in sync with HEARTBEAT_MS in src/game/net.ts.
create function public.room_seats_json(p_room text)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'now', (extract(epoch from clock_timestamp()) * 1000)::bigint,
    'seats', coalesce(jsonb_agg(jsonb_build_object(
      'id', s.id,
      'user_id', s.user_id,
      'name', s.name,
      'public_key', s.public_key,
      'joined_at', (extract(epoch from s.joined_at) * 1000)::bigint
    ) order by s.joined_at, s.id), '[]'::jsonb)
  )
  from public.room_seats s
  where s.room = p_room and s.seen_at > clock_timestamp() - interval '15 seconds';
$$;

/** Take a seat in a room. Replaces any seat this account already holds there (e.g. another tab). */
create function public.join_room(p_room text, p_public_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_id uuid;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  if p_room !~ '^[A-Z0-9]{1,16}$' or p_public_key !~ '^[A-Za-z0-9+/=]{1,200}$' then
    raise exception 'invalid_seat';
  end if;

  -- Serialize joins per room so two players can't both take the tenth seat.
  perform pg_advisory_xact_lock(hashtext('room_seats:' || p_room));

  delete from public.room_seats
  where room = p_room and (user_id = v_uid or seen_at <= clock_timestamp() - interval '15 seconds');

  if (select count(*) from public.room_seats where room = p_room) >= 10 then
    raise exception 'room_full';
  end if;

  insert into public.room_seats (room, user_id, name, public_key, joined_at, seen_at)
  select
    p_room,
    v_uid,
    left(coalesce(nullif(u.raw_user_meta_data ->> 'username', ''), split_part(u.email, '@', 1), 'Hero'), 16),
    p_public_key,
    clock_timestamp(),
    clock_timestamp()
  from auth.users u
  where u.id = v_uid
  returning id into v_id;

  return public.room_seats_json(p_room) || jsonb_build_object('id', v_id);
end;
$$;

/** Keep a seat alive and get the room's live seats back. */
create function public.room_heartbeat(p_room text, p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.room_seats
  set seen_at = clock_timestamp()
  where id = p_id and room = p_room and user_id = auth.uid();
  if not found then
    raise exception 'seat_lost';
  end if;
  return public.room_seats_json(p_room);
end;
$$;

/**
 * After a dropped connection, move a seat to the back of the host order (and keep it alive).
 * This can only make the caller's join time later, so it can't be used to take the host role.
 */
create function public.room_rejoin(p_room text, p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.room_seats
  set joined_at = clock_timestamp(), seen_at = clock_timestamp()
  where id = p_id and room = p_room and user_id = auth.uid();
  if not found then
    raise exception 'seat_lost';
  end if;
  return public.room_seats_json(p_room);
end;
$$;

create function public.leave_room(p_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.room_seats where id = p_id and user_id = auth.uid();
$$;

revoke execute on function public.room_seats_json(text) from public, anon, authenticated;
revoke execute on function public.join_room(text, text) from public, anon;
revoke execute on function public.room_heartbeat(text, uuid) from public, anon;
revoke execute on function public.room_rejoin(text, uuid) from public, anon;
revoke execute on function public.leave_room(uuid) from public, anon;
grant execute on function public.join_room(text, text) to authenticated;
grant execute on function public.room_heartbeat(text, uuid) to authenticated;
grant execute on function public.room_rejoin(text, uuid) to authenticated;
grant execute on function public.leave_room(uuid) to authenticated;
