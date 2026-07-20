// Tools the in-app agent can call. Reads run immediately against Supabase (the signed-in user's own
// data via RLS). Writes DON'T run here — they return a `confirm` with a summary + a `run()` the UI
// executes only after the user approves, so the agent can never silently change your inventory.

import { supabase } from "@/integrations/supabase/client";
import { mintShortCode } from "@/lib/shortcode";

export interface ToolResult {
  result?: unknown;
  confirm?: { summary: string; run: () => Promise<unknown> };
}

// OpenAI/OpenRouter function-tool schemas the model sees.
export const TOOL_SCHEMAS = [
  { type: "function", function: { name: "search_items", description: "Search inventory items by name, category, or brand. Returns matches with code, category, brand, quantity.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } },
  { type: "function", function: { name: "locate_item", description: "Find which bin/location an item is stored in, by item name.", parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } } },
  { type: "function", function: { name: "list_bins", description: "List bins with their category label and item count.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "bin_contents", description: "List everything stored in a bin, by bin name like 'Bin 4'.", parameters: { type: "object", properties: { bin: { type: "string" } }, required: ["bin"] } } },
  { type: "function", function: { name: "create_item", description: "Create a new item, optionally filing it into a bin. WRITE — user confirms first.", parameters: { type: "object", properties: { name: { type: "string" }, category: { type: "string" }, brand: { type: "string" }, size: { type: "string" }, bin: { type: "string", description: "bin name to file into (optional)" } }, required: ["name"] } } },
  { type: "function", function: { name: "move_item", description: "Move an existing item into a bin. WRITE — user confirms first.", parameters: { type: "object", properties: { item: { type: "string" }, bin: { type: "string" } }, required: ["item", "bin"] } } },
  { type: "function", function: { name: "set_bin_category", description: "Set what a bin holds (its printed label). WRITE — user confirms first.", parameters: { type: "object", properties: { bin: { type: "string" }, category: { type: "string" } }, required: ["bin", "category"] } } },
  { type: "function", function: { name: "ask_user_choice", description: "Ask the user a multiple-choice question when you need them to pick between options. The app shows tappable buttons and returns their choice.", parameters: { type: "object", properties: { question: { type: "string" }, options: { type: "array", items: { type: "string" } } }, required: ["question", "options"] } } },
] as const;

export const AGENT_SYSTEM_PROMPT =
  "You are the Tool Vision assistant inside a garage tool-inventory app. Help the owner find, count, " +
  "and organize their tools and bins. ALWAYS use the tools to look things up before answering — never " +
  "guess quantities or locations. Keep replies short and practical. For any change (create/move item, " +
  "relabel a bin) call the matching write tool; the app asks the user to confirm before it happens. If " +
  "you're unsure which item or bin the user means, ask one brief clarifying question with 2-4 concrete " +
  "options. When the user sends a photo, identify what's in it and offer to file it.";

const like = (s: string) => `%${String(s || "").replace(/[%,]/g, " ").trim()}%`;

async function findBin(name: string): Promise<{ id: string; name: string } | null> {
  const { data } = await supabase.from("locations").select("id,name").eq("type", "bin").ilike("name", like(name)).limit(1);
  return (data?.[0] as { id: string; name: string }) || null;
}
async function findItem(name: string): Promise<{ id: string; name: string } | null> {
  const { data } = await supabase.from("items").select("id,name").ilike("name", like(name)).limit(1);
  return (data?.[0] as { id: string; name: string }) || null;
}

export async function executeTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const a = args || {};
  switch (name) {
    case "search_items": {
      const q = String(a.query || "");
      const { data } = await supabase.from("items")
        .select("name,qr_code,category,brand,quantity")
        .or(`name.ilike.${like(q)},category.ilike.${like(q)},brand.ilike.${like(q)}`).limit(20);
      return { result: data || [] };
    }
    case "locate_item": {
      const item = await findItem(String(a.name || ""));
      if (!item) return { result: { found: false } };
      const { data } = await supabase.from("item_locations")
        .select("quantity, locations(name)").eq("item_id", item.id).is("date_removed", null);
      const places = (data || []).map((r) => ({ bin: (r as { locations?: { name?: string } }).locations?.name, quantity: (r as { quantity?: number }).quantity }));
      return { result: { item: item.name, places } };
    }
    case "list_bins": {
      const { data: bins } = await supabase.from("locations").select("id,name,category").eq("type", "bin");
      const list = (bins || []) as Array<{ id: string; name: string; category?: string }>;
      const counts = await Promise.all(list.map(async (b) => {
        const { count } = await supabase.from("item_locations").select("*", { count: "exact", head: true }).eq("location_id", b.id).is("date_removed", null);
        return { bin: b.name, category: b.category || null, items: count || 0 };
      }));
      return { result: counts.sort((x, y) => (Number(x.bin.match(/\d+/)?.[0]) || 0) - (Number(y.bin.match(/\d+/)?.[0]) || 0)) };
    }
    case "bin_contents": {
      const bin = await findBin(String(a.bin || ""));
      if (!bin) return { result: { found: false } };
      const { data } = await supabase.from("item_locations")
        .select("quantity, items(name,qr_code,category,brand)").eq("location_id", bin.id).is("date_removed", null);
      const items = (data || []).map((r) => ({ ...(r as { items?: object }).items as object, quantity: (r as { quantity?: number }).quantity }));
      return { result: { bin: bin.name, items } };
    }
    case "create_item": {
      const nm = String(a.name || "").trim();
      const binName = a.bin ? String(a.bin) : "";
      // Resolve the bin BEFORE confirming, so the summary is truthful and we never create an orphan
      // item when the named bin doesn't exist.
      const bin = binName ? await findBin(binName) : null;
      if (binName && !bin) return { result: { error: `Couldn't find bin “${binName}”. Nothing was created — check the bin name and try again.` } };
      return { confirm: {
        summary: `Create “${nm}”${a.category ? ` (${a.category})` : ""}${bin ? ` and file into ${bin.name}` : ""}`,
        run: async () => {
          const code = await mintShortCode();
          const { data: created, error } = await supabase.from("items").insert({
            name: nm, category: String(a.category || "Other"), quantity: 1, quantity_unit: "piece", qr_code: code,
            ...(a.brand ? { brand: String(a.brand) } : {}), ...(a.size ? { size_specs: String(a.size) } : {}),
          }).select("id").single();
          if (error) throw error;
          if (bin) {
            // Don't claim it was filed unless the link actually succeeded.
            const { error: linkErr } = await supabase.from("item_locations").insert({ item_id: created!.id, location_id: bin.id, quantity: 1 });
            if (linkErr) return { created: nm, code, bin: null, warning: `Created, but couldn't file into ${bin.name}: ${linkErr.message}. File it manually.` };
          }
          return { created: nm, code, bin: bin?.name || null };
        },
      } };
    }
    case "move_item": {
      const itemName = String(a.item || ""), binName = String(a.bin || "");
      // Resolve BOTH before confirming: the summary must name the exact item/bin the run will touch,
      // and we fail cleanly (no confirm) if either can't be found.
      const item = await findItem(itemName);
      const bin = await findBin(binName);
      if (!item || !bin) return { result: { error: `Couldn't find ${!item ? `item “${itemName}”` : `bin “${binName}”`}. Nothing moved.` } };
      return { confirm: {
        summary: `Move “${item.name}” into ${bin.name}`,
        run: async () => {
          // Read current placements so we can preserve quantity (never silently reset it to 1).
          const { data: current } = await supabase.from("item_locations")
            .select("id,location_id,quantity").eq("item_id", item.id).is("date_removed", null);
          const rows = (current || []) as Array<{ id: string; location_id: string; quantity?: number }>;
          const qty = rows.reduce((s, r) => s + (r.quantity || 1), 0) || 1;
          const now = new Date().toISOString();
          // Remove it from every location EXCEPT the target.
          const toRemove = rows.filter((r) => r.location_id !== bin.id).map((r) => r.id);
          if (toRemove.length) {
            const { error } = await supabase.from("item_locations").update({ date_removed: now }).in("id", toRemove);
            if (error) return { error: `Couldn't move: ${error.message}` };
          }
          // Land it in the target. There's a UNIQUE(item_id, location_id), so a prior (even soft-removed)
          // row for this bin must be REACTIVATED, not re-inserted (which would throw).
          const { data: prior } = await supabase.from("item_locations")
            .select("id").eq("item_id", item.id).eq("location_id", bin.id).limit(1);
          if (prior && prior[0]) {
            const { error } = await supabase.from("item_locations")
              .update({ date_removed: null, quantity: qty }).eq("id", (prior[0] as { id: string }).id);
            if (error) return { error: `Couldn't move: ${error.message}` };
          } else {
            const { error } = await supabase.from("item_locations")
              .insert({ item_id: item.id, location_id: bin.id, quantity: qty });
            if (error) return { error: `Couldn't move: ${error.message}` };
          }
          return { moved: item.name, to: bin.name, quantity: qty };
        },
      } };
    }
    case "set_bin_category": {
      const binName = String(a.bin || ""), cat = String(a.category || "");
      return { confirm: {
        summary: `Label ${binName} → “${cat}”`,
        run: async () => {
          const bin = await findBin(binName);
          if (!bin) return { error: "bin not found" };
          await supabase.from("locations").update({ category: cat }).eq("id", bin.id);
          return { bin: bin.name, category: cat };
        },
      } };
    }
    default:
      return { result: { error: `unknown tool ${name}` } };
  }
}
