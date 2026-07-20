-- Print jobs: the hand-off between anything that wants a label and the Mac that owns the printer.
--
-- The desktop connector is the only thing that can reach the QL-800, and it is a LaunchAgent that is
-- always running. Everything else (the web app, the iOS app, the Claude-app MCP connector) enqueues
-- here and the connector drains it. That removes the previous requirement that a browser tab be open
-- for a label to print, and it means a label queued while the Mac is asleep prints when it wakes
-- rather than being lost.
create table if not exists public.print_jobs (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null,
  -- The label to render: {title, lines[], badge, qr, media}. Rendered by the connector, not here,
  -- so a job stays valid even if label styling changes.
  spec        jsonb not null,
  status      text  not null default 'queued' check (status in ('queued', 'printing', 'done', 'failed')),
  attempts    int   not null default 0,
  error       text,
  source      text,
  created_at  timestamptz not null default now(),
  printed_at  timestamptz
);

-- The connector's drain query: oldest queued job for this owner.
create index if not exists print_jobs_queue_idx
  on public.print_jobs (owner_id, status, created_at)
  where status in ('queued', 'printing');

alter table public.print_jobs enable row level security;

-- Same per-user isolation as every other table here: you only ever see your own jobs. The connector
-- and the MCP endpoint use the service-role key and scope by owner_id explicitly.
drop policy if exists "own print jobs" on public.print_jobs;
create policy "own print jobs" on public.print_jobs
  for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
