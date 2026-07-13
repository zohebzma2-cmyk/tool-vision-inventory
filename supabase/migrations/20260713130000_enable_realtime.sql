-- Live cross-device sync: publish inventory tables so the app's realtime channel
-- receives inserts/updates/deletes (desktop <-> phone update instantly).
-- Safe to re-run: each ADD TABLE is guarded.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'items'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.items;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'locations'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.locations;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'item_locations'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.item_locations;
  END IF;
END $$;
