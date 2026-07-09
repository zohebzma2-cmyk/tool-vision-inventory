-- Spatial / slot layer for "spaces done properly"
-- A container location (pegboard, drawer grid, shelf, cabinet, wall, room) can be a GRID of slots.
-- Each slot is itself a row in `locations` (child via parent_location_id) carrying grid coordinates,
-- so "what's in slot [r,c]" reuses the existing item_locations junction with no new table.

-- 1. Grid definition on the parent container + physical-space memory fields.
ALTER TABLE public.locations
  ADD COLUMN IF NOT EXISTS grid_rows  INTEGER,               -- rows of the parent's slot grid (NULL = not a grid)
  ADD COLUMN IF NOT EXISTS grid_cols  INTEGER,               -- cols of the parent's slot grid
  ADD COLUMN IF NOT EXISTS slot_row   INTEGER,               -- this slot's 1-based row within its parent grid
  ADD COLUMN IF NOT EXISTS slot_col   INTEGER,               -- this slot's 1-based col within its parent grid
  ADD COLUMN IF NOT EXISTS slot_index INTEGER,               -- this slot's 1-based sequential index within its parent
  ADD COLUMN IF NOT EXISTS is_slot    BOOLEAN NOT NULL DEFAULT false, -- true = a slot inside a grid, false = a container
  ADD COLUMN IF NOT EXISTS image_path TEXT,                  -- photo of the physical space (memory of the space)
  ADD COLUMN IF NOT EXISTS layout     JSONB;                 -- freeform: naming scheme, label template, per-cell overrides

-- 2. Relax the type CHECK so users can map arbitrary spaces (a wall, a room, a whole area) into grids.
ALTER TABLE public.locations DROP CONSTRAINT IF EXISTS locations_type_check;
ALTER TABLE public.locations
  ADD CONSTRAINT locations_type_check
  CHECK (type IN (
    'bin','pegboard','drawer','shelf','hook','rack','cabinet',
    'slot','space','wall','room','area','board','other'
  ));

-- 3. One slot per (parent, row, col). Partial unique index so non-slot containers are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS idx_locations_parent_slot_coords
  ON public.locations (parent_location_id, slot_row, slot_col)
  WHERE is_slot = true;

CREATE INDEX IF NOT EXISTS idx_locations_parent ON public.locations (parent_location_id);
CREATE INDEX IF NOT EXISTS idx_locations_is_slot ON public.locations (is_slot);

-- 4. Utilization view: for every container, how many slots exist and how many are occupied.
CREATE OR REPLACE VIEW public.location_utilization AS
SELECT
  parent.id                                              AS location_id,
  parent.name                                            AS location_name,
  parent.grid_rows,
  parent.grid_cols,
  COUNT(slot.id)                                         AS slot_count,
  COUNT(slot.id) FILTER (WHERE occ.occupied_slots > 0)   AS occupied_slot_count,
  COUNT(slot.id) FILTER (WHERE COALESCE(occ.occupied_slots, 0) = 0) AS empty_slot_count
FROM public.locations parent
LEFT JOIN public.locations slot
  ON slot.parent_location_id = parent.id AND slot.is_slot = true
LEFT JOIN LATERAL (
  SELECT COUNT(*) AS occupied_slots
  FROM public.item_locations il
  WHERE il.location_id = slot.id AND il.date_removed IS NULL
) occ ON true
GROUP BY parent.id, parent.name, parent.grid_rows, parent.grid_cols;
