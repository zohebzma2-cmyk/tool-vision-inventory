-- Warranty + maintenance tracking (adopted from HomeBox, kept frictionless).
-- All nullable so nothing is required and old rows/clients keep working.
ALTER TABLE public.items
  ADD COLUMN IF NOT EXISTS warranty_until DATE,            -- "in warranty until this date"
  ADD COLUMN IF NOT EXISTS service_interval_months INTEGER, -- remind to service every N months
  ADD COLUMN IF NOT EXISTS last_serviced DATE;             -- one-tap "Log service" stamps today
