-- Schema for the WhatsApp reader. On a fresh Supabase project: SQL Editor → paste all → Run.

-- 1. Raw WhatsApp messages (written by the ingest edge function; no display names are stored)
create table raw_messages (
  id           text primary key,              -- WhatsApp message id → free dedupe
  group_id     text not null,
  sender       text,
  text         text not null,
  sent_at      timestamptz not null,
  created_at   timestamptz not null default now()
);
create index on raw_messages (group_id, sent_at);
alter table raw_messages enable row level security;

-- 2. Group invite links (anyone with the publishable key can submit one; the listener joins)
create table group_invites (
  id          uuid primary key default gen_random_uuid(),
  invite_link text not null,
  status      text not null default 'pending',   -- pending | joining | joined | failed
  group_id    text,
  group_name  text,
  error       text,
  created_at  timestamptz not null default now()
);
alter table group_invites enable row level security;
create policy "anon insert pending" on group_invites for insert to anon with check (status = 'pending');
create policy "anon read" on group_invites for select to anon using (true);

-- 3. Realtime: the listener reacts to new invites the moment they're inserted
alter publication supabase_realtime add table group_invites;
