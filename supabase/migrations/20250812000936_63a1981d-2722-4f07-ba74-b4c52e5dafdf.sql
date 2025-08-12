-- Add qr_code to items so each item can have a scannable code
ALTER TABLE public.items
ADD COLUMN IF NOT EXISTS qr_code text;

-- Optional: speed up lookups by qr_code
CREATE INDEX IF NOT EXISTS idx_items_qr_code ON public.items (qr_code);
