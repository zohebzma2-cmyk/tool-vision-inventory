import { createClient } from '@supabase/supabase-js';
import type { Database } from './types';

// Configure via environment (.env). No hardcoded project fallback — a fork must supply its own
// VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY (see .env.example) so it never points at someone else's DB.
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const SUPABASE_PUBLISHABLE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
  throw new Error("Missing Supabase config: set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in your .env");
}

// Import the supabase client like this:
// import { supabase } from "@/integrations/supabase/client";

export const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    storage: localStorage,
    persistSession: true,
    autoRefreshToken: true,
  }
});