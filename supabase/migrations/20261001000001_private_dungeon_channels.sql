-- Dungeon rooms run on private Realtime channels (`dungeon:<CODE>`, created with `private: true`).
-- Private channels are authorized by RLS on realtime.messages, so only signed-in users can
-- join a room, receive its broadcasts/presence, or send to it. Anonymous clients holding the
-- publishable key are rejected at subscribe time.
--
-- Also required (dashboard, not SQL): Project Settings → Realtime → turn OFF
-- "Allow public access", so clients can't fall back to public channels.

-- RLS is already enabled on realtime.messages, and the table belongs to Supabase, so it can't be
-- altered here ("must be owner of table messages"). Only the policies are ours to add.

drop policy if exists "dungeon members can receive" on realtime.messages;
create policy "dungeon members can receive"
on realtime.messages
for select
to authenticated
using (
  realtime.topic() like 'dungeon:%'
  and realtime.messages.extension in ('broadcast', 'presence')
);

drop policy if exists "dungeon members can send" on realtime.messages;
create policy "dungeon members can send"
on realtime.messages
for insert
to authenticated
with check (
  realtime.topic() like 'dungeon:%'
  and realtime.messages.extension in ('broadcast', 'presence')
);
