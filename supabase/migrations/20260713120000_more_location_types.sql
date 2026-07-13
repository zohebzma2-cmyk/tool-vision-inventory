-- Allow the storage archetypes added to the app (toolbox, tool bag) so creating a
-- space of those types no longer violates the type check.
ALTER TABLE public.locations DROP CONSTRAINT IF EXISTS locations_type_check;
ALTER TABLE public.locations
  ADD CONSTRAINT locations_type_check
  CHECK (type IN (
    'bin','pegboard','drawer','shelf','hook','rack','cabinet',
    'slot','space','wall','room','area','board','toolbox','tool bag','other'
  ));
