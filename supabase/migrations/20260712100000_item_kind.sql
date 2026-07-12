-- Classify each item as a part, tool, set, or consumable (the "part? tool? or set?"
-- axis from the inventory workflow). Nullable so existing rows and clients that
-- don't send it keep working.
ALTER TABLE public.items
  ADD COLUMN IF NOT EXISTS kind TEXT
  CHECK (kind IS NULL OR kind IN ('part', 'tool', 'set', 'consumable'));

CREATE INDEX IF NOT EXISTS idx_items_kind ON public.items (kind);
