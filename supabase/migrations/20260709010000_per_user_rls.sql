-- Per-user data ownership + strict Row Level Security.
-- Replaces the previous anonymous, world-readable/writable policies. After this migration every
-- row belongs to a Supabase auth user and is only visible/editable by that user.

-- 1. owner_id on every user-data table, defaulting to the authenticated caller.
ALTER TABLE public.items
  ADD COLUMN IF NOT EXISTS owner_id UUID DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.locations
  ADD COLUMN IF NOT EXISTS owner_id UUID DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.item_locations
  ADD COLUMN IF NOT EXISTS owner_id UUID DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.usage_log
  ADD COLUMN IF NOT EXISTS owner_id UUID DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_items_owner ON public.items(owner_id);
CREATE INDEX IF NOT EXISTS idx_locations_owner ON public.locations(owner_id);
CREATE INDEX IF NOT EXISTS idx_item_locations_owner ON public.item_locations(owner_id);
CREATE INDEX IF NOT EXISTS idx_usage_log_owner ON public.usage_log(owner_id);

-- 2. Remove the old public-access policies.
DROP POLICY IF EXISTS "Public access to items" ON public.items;
DROP POLICY IF EXISTS "Public access to locations" ON public.locations;
DROP POLICY IF EXISTS "Public access to item_locations" ON public.item_locations;
DROP POLICY IF EXISTS "Public access to usage_log" ON public.usage_log;

-- 3. Owner-only policies for authenticated users.
DO $$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['items','locations','item_locations','usage_log'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS owner_select ON public.%I', tbl);
    EXECUTE format('DROP POLICY IF EXISTS owner_insert ON public.%I', tbl);
    EXECUTE format('DROP POLICY IF EXISTS owner_update ON public.%I', tbl);
    EXECUTE format('DROP POLICY IF EXISTS owner_delete ON public.%I', tbl);
    EXECUTE format('CREATE POLICY owner_select ON public.%I FOR SELECT TO authenticated USING (owner_id = auth.uid())', tbl);
    EXECUTE format('CREATE POLICY owner_insert ON public.%I FOR INSERT TO authenticated WITH CHECK (owner_id = auth.uid())', tbl);
    EXECUTE format('CREATE POLICY owner_update ON public.%I FOR UPDATE TO authenticated USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid())', tbl);
    EXECUTE format('CREATE POLICY owner_delete ON public.%I FOR DELETE TO authenticated USING (owner_id = auth.uid())', tbl);
  END LOOP;
END $$;

-- 4. Lock down unused legacy tables (were world-writable from an earlier template).
--    RLS stays enabled with no permissive policy => no anonymous access.
--    Guarded by existence checks so a fresh clone (which never had these tables) still applies.
DO $$
BEGIN
  IF to_regclass('public."User"') IS NOT NULL THEN
    DROP POLICY IF EXISTS "Public access to User" ON public."User";
  END IF;
  IF to_regclass('public.customers') IS NOT NULL THEN
    DROP POLICY IF EXISTS "Public access to customers" ON public.customers;
    DROP POLICY IF EXISTS "Public delete customers" ON public.customers;
    DROP POLICY IF EXISTS "Public update customers" ON public.customers;
  END IF;
  IF to_regclass('public.invoices') IS NOT NULL THEN
    DROP POLICY IF EXISTS "Public access to invoices" ON public.invoices;
    DROP POLICY IF EXISTS "Public delete invoices" ON public.invoices;
  END IF;
  IF to_regclass('public.payments') IS NOT NULL THEN
    DROP POLICY IF EXISTS "Public access to payments" ON public.payments;
    DROP POLICY IF EXISTS "Public delete payments" ON public.payments;
  END IF;
END $$;

-- NOTE: any rows created before this migration have NULL owner_id and are intentionally
-- inaccessible under the new policies. Seed/demo data should be re-created per account.
