import { useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";

/**
 * Live cross-device sync. The web app and the iOS app share one Supabase project and
 * account, so data is always the same source; this makes changes appear *instantly*
 * across every signed-in device (add a tool on the desktop, watch it show up on the
 * phone) by subscribing to Postgres changes and re-running the given refresh.
 *
 * Debounced so a burst of inserts (e.g. cataloging a bin) triggers one refresh.
 */
export function useRealtimeSync(tables: string[], onChange: () => void) {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const fire = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(onChange, 400);
    };

    const channel = supabase.channel("tvi-sync");
    for (const table of tables) {
      channel.on("postgres_changes", { event: "*", schema: "public", table }, fire);
    }
    channel.subscribe();

    return () => {
      if (timer) clearTimeout(timer);
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tables.join(",")]);
}
