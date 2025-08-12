-- Seed structured storage locations (bins, pegboard, drawers, areas) if missing
-- Sockets Cabinet and 5 drawers
WITH cab AS (
  SELECT id FROM public.locations WHERE name = 'Sockets Cabinet'
  UNION ALL
  SELECT id FROM (
    INSERT INTO public.locations (name, type, qr_code, description, capacity)
    SELECT 'Sockets Cabinet','cabinet','CAB-SOCKETS','Small 5-drawer setup for sockets', NULL
    WHERE NOT EXISTS (SELECT 1 FROM public.locations WHERE name = 'Sockets Cabinet')
    RETURNING id
  ) ins
  LIMIT 1
)
INSERT INTO public.locations (name, type, qr_code, capacity, parent_location_id, description)
SELECT
  format('Socket Drawer %s', g.n),
  'drawer',
  format('SOCKET-%02s', g.n),
  200,
  (SELECT id FROM cab),
  'Drawer for socket sets'
FROM (SELECT 1 as n UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5) g
WHERE NOT EXISTS (
  SELECT 1 FROM public.locations WHERE qr_code = format('SOCKET-%02s', g.n)
);

-- 20 bins
WITH nums AS (SELECT generate_series(1,20) AS n)
INSERT INTO public.locations (name, type, qr_code, capacity, description)
SELECT
  format('Bin %s', lpad(n::text,2,'0')),
  'bin',
  format('BIN-%s', lpad(n::text,2,'0')),
  500,
  'General purpose bin'
FROM nums
WHERE NOT EXISTS (
  SELECT 1 FROM public.locations WHERE qr_code = format('BIN-%s', lpad(n::text,2,'0'))
);

-- 100 pegboard slots
WITH nums AS (SELECT generate_series(1,100) AS n)
INSERT INTO public.locations (name, type, qr_code, capacity, description)
SELECT
  format('Pegboard Slot %s', lpad(n::text,3,'0')),
  'pegboard',
  format('PEG-%s', lpad(n::text,3,'0')),
  1,
  'Pegboard tool slot'
FROM nums
WHERE NOT EXISTS (
  SELECT 1 FROM public.locations WHERE qr_code = format('PEG-%s', lpad(n::text,3,'0'))
);

-- Large 4x8 drawer
INSERT INTO public.locations (name, type, qr_code, capacity, description)
SELECT 'Drawer 4x8', 'drawer', 'DRAWER-4X8', 80, 'Large drawer for power tools'
WHERE NOT EXISTS (SELECT 1 FROM public.locations WHERE qr_code = 'DRAWER-4X8');

-- Areas
INSERT INTO public.locations (name, type, qr_code, description)
SELECT 'Large Items Area', 'rack', 'AREA-LARGE', 'Space for large/heavy items'
WHERE NOT EXISTS (SELECT 1 FROM public.locations WHERE qr_code = 'AREA-LARGE');

INSERT INTO public.locations (name, type, qr_code, description)
SELECT 'General Items', 'shelf', 'AREA-GENERAL', 'General storage area'
WHERE NOT EXISTS (SELECT 1 FROM public.locations WHERE qr_code = 'AREA-GENERAL');