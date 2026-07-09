import { createClient } from '@supabase/supabase-js';
import type { Database } from './types';

// Configure via environment (.env). Falls back to the original hosted project so existing
// deployments keep working until self-hosted Supabase creds are provided.
const SUPABASE_URL =
  import.meta.env.VITE_SUPABASE_URL ?? "https://uyewoueovyjbljrsmmnu.supabase.co";
const SUPABASE_PUBLISHABLE_KEY =
  import.meta.env.VITE_SUPABASE_ANON_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV5ZXdvdWVvdnlqYmxqcnNtbW51Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDA0MjY1ODQsImV4cCI6MjA1NjAwMjU4NH0.OjQEfygHR3r6oLBR-HVhYEEeCZEKb3cJQiaYUlXkeRg";

// Import the supabase client like this:
// import { supabase } from "@/integrations/supabase/client";

export const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    storage: localStorage,
    persistSession: true,
    autoRefreshToken: true,
  }
});