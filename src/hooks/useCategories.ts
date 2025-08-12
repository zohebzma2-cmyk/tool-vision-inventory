import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

// Centralized categories management. Starts with defaults and expands with any
// categories found in the DB or added by the user at runtime.
const DEFAULT_CATEGORIES = [
  "Power Tools",
  "Hand Tools",
  "Fasteners",
  "Hardware",
  "Safety Equipment",
  "Electrical",
  "Plumbing",
  "Cutting Tools",
  "Measuring Tools",
  "Other",
];

export function useCategories() {
  const [categories, setCategories] = useState<string[]>(DEFAULT_CATEGORIES);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        setLoading(true);
        const { data, error } = await supabase
          .from('items')
          .select('category');
        if (error) throw error;
        const dbCats = (data || [])
          .map((r: any) => (r?.category ? String(r.category) : null))
          .filter((c: string | null): c is string => !!c);
        const merged = Array.from(new Set([...DEFAULT_CATEGORIES, ...dbCats])).sort();
        if (mounted) setCategories(merged);
      } catch (_) {
        // keep defaults silently
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, []);

  const addCategory = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setCategories(prev => Array.from(new Set([...prev, trimmed])).sort());
  };

  const categoriesForFilter = useMemo(() => ["all", ...categories], [categories]);

  return { categories, addCategory, categoriesForFilter, loading } as const;
}
