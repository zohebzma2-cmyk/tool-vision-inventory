-- Storage bucket for item + location photos.
--
-- Image bytes previously lived as base64 `data:` URLs inside TEXT columns (items.photo_path /
-- locations.image_path), which bloats every row and every query. They now live in this bucket and
-- the columns hold a plain public URL. Existing base64 rows keep rendering (an <img src> accepts
-- both a data: URL and an https URL), so this migration is backward-compatible — no data backfill
-- required.
--
-- Reads: public. Objects live under unguessable UUID paths, so a public bucket keeps them private
-- in practice while letting <img src> load them with no signed-URL expiry to break.
-- Writes: owner-scoped. Every object path starts with "<auth.uid()>/", and the policies below let a
-- signed-in user write only under their own folder — mirroring the per-user RLS on the data tables.

insert into storage.buckets (id, name, public)
values ('inventory-images', 'inventory-images', true)
on conflict (id) do update set public = excluded.public;

-- Owner-scoped INSERT: only into your own "<uid>/..." folder of this bucket.
drop policy if exists "inventory-images owner insert" on storage.objects;
create policy "inventory-images owner insert"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'inventory-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Owner-scoped UPDATE (e.g. re-upsert of a replaced photo).
drop policy if exists "inventory-images owner update" on storage.objects;
create policy "inventory-images owner update"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'inventory-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'inventory-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Owner-scoped DELETE (so removing an item/bin can clean up its object).
drop policy if exists "inventory-images owner delete" on storage.objects;
create policy "inventory-images owner delete"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'inventory-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Public reads come from the bucket's public=true flag; no SELECT policy is needed for a public
-- bucket. (If this is ever switched to a private bucket, add an owner SELECT policy and move the
-- app to createSignedUrl.)
