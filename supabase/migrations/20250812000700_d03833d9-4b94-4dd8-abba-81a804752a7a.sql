-- Add a category column to locations to enable bin categorization
ALTER TABLE public.locations
ADD COLUMN IF NOT EXISTS category text;