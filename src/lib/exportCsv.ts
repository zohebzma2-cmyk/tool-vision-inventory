import { supabase } from "@/integrations/supabase/client";

/** One field, CSV-escaped. */
function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Export the whole inventory as a CSV — every tool, where it lives, and its details.
 * One tap, no options. Returns the row count. */
export async function exportInventoryCsv(): Promise<number> {
  const [{ data: items }, { data: links }, { data: locs }] = await Promise.all([
    supabase.from("items").select("*").order("name"),
    supabase.from("item_locations").select("item_id, location_id").is("date_removed", null),
    supabase.from("locations").select("id, name"),
  ]);

  const locName = new Map((locs ?? []).map((l: { id: string; name: string }) => [l.id, l.name]));
  const itemLoc = new Map<string, string>();
  (links ?? []).forEach((l: { item_id: string; location_id: string }) => {
    const n = locName.get(l.location_id);
    if (n && !itemLoc.has(l.item_id)) itemLoc.set(l.item_id, n);
  });

  const cols = [
    ["Name", "name"], ["Category", "category"], ["Kind", "kind"], ["Brand", "brand"],
    ["Model", "model"], ["Size / specs", "size_specs"], ["Quantity", "quantity"],
    ["Unit", "quantity_unit"], ["Location", null], ["Purchase date", "purchase_date"],
    ["Purchase price", "purchase_price"], ["Warranty until", "warranty_until"],
    ["Service every (months)", "service_interval_months"], ["Last serviced", "last_serviced"],
    ["Notes", "notes"], ["QR code", "qr_code"],
  ] as const;

  const header = cols.map(([h]) => cell(h)).join(",");
  const rows = (items ?? []).map((it: Record<string, unknown>) =>
    cols.map(([, key]) => cell(key === null ? itemLoc.get(it.id as string) ?? "" : it[key])).join(","),
  );
  const csv = [header, ...rows].join("\r\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `tool-vision-inventory-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  return rows.length;
}
