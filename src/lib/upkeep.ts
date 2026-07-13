/** Warranty + maintenance status for an item — computed, so the UI just shows a badge. */

export interface UpkeepFields {
  warranty_until?: string | null;
  service_interval_months?: number | null;
  last_serviced?: string | null;
}

export type WarrantyState = { label: string; tone: "success" | "muted" } | null;

/** "In warranty" (green) until the date, then "Warranty expired" (grey). Null if no date. */
export function warrantyState(item: UpkeepFields, today = new Date()): WarrantyState {
  if (!item.warranty_until) return null;
  const until = new Date(item.warranty_until + "T00:00:00");
  if (Number.isNaN(until.getTime())) return null;
  const days = Math.round((until.getTime() - today.getTime()) / 86400000);
  if (days < 0) return { label: "Warranty expired", tone: "muted" };
  if (days <= 30) return { label: `Warranty ends in ${days}d`, tone: "success" };
  return { label: `In warranty to ${until.toLocaleDateString(undefined, { month: "short", year: "numeric" })}`, tone: "success" };
}

export type ServiceState = { label: string; tone: "warning" | "muted" } | null;

/** "Service due" (amber) once past last_serviced + interval. Null if no interval set. */
export function serviceState(item: UpkeepFields, today = new Date()): ServiceState {
  const interval = item.service_interval_months;
  if (!interval || interval <= 0) return null;
  const base = item.last_serviced ? new Date(item.last_serviced + "T00:00:00") : null;
  if (!base) return { label: "Service due", tone: "warning" };
  const due = new Date(base);
  due.setMonth(due.getMonth() + interval);
  const days = Math.round((due.getTime() - today.getTime()) / 86400000);
  if (days <= 0) return { label: "Service due", tone: "warning" };
  if (days <= 14) return { label: `Service in ${days}d`, tone: "warning" };
  return { label: `Serviced · next ${due.toLocaleDateString(undefined, { month: "short" })}`, tone: "muted" };
}

/** Today's date as YYYY-MM-DD (local), for stamping "last serviced". */
export function todayISO(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
