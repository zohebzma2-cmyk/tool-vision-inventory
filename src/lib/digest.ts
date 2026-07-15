// Weekly organization digest (client-triggered). When the app is opened and it's been ≥7 days since
// the last run, compute the org report and, if there's anything worth surfacing, nudge the owner:
//   • text  — via the desktop connector's iMessage bridge (free, when the Mac + connector are up)
//   • email — via the vision Worker's /digest endpoint (Resend; no-ops until RESEND_API_KEY is set)
// The in-app Sort Mode screen is the always-available view; this is just the weekly push on top.

import { supabase } from "@/integrations/supabase/client";
import { computeOrgReport, type OrgReport } from "@/lib/organize";
import { visionApiUrl } from "@/lib/vision";
import { isConnectorAvailable, notifyTextViaConnector } from "@/components/inventory/PrinterService";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const lastKey = (userId: string) => `tv-digest-last:${userId}`;

function dueForDigest(userId: string): boolean {
  try {
    const last = localStorage.getItem(lastKey(userId));
    if (!last) return true;
    return Date.now() - new Date(last).getTime() >= WEEK_MS;
  } catch {
    return false;
  }
}

function markRun(userId: string) {
  try { localStorage.setItem(lastKey(userId), new Date().toISOString()); } catch { /* ignore */ }
}

/** One-line text nudge, e.g. "Tool Vision: 1 space filling up, 2 items out of place. Time to sort." */
function textBody(r: OrgReport): string {
  return `Tool Vision — ${r.summary} Open Sort Mode to tidy up.`;
}

function emailHtml(r: OrgReport): string {
  const rows = r.suggestions.slice(0, 20).map((s) => {
    const color = s.severity === "urgent" ? "#dc2626" : s.severity === "warning" ? "#d97706" : "#0284c7";
    return `<tr>
      <td style="padding:8px 10px;border-bottom:1px solid #eee;vertical-align:top;color:${color};font-weight:600;white-space:nowrap">${s.severity}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #eee">
        <div style="font-weight:600;color:#111">${escapeHtml(s.title)}</div>
        <div style="color:#555;font-size:13px">${escapeHtml(s.detail)}</div>
      </td></tr>`;
  }).join("");
  return `<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;max-width:560px;margin:0 auto">
    <h2 style="margin:0 0 4px">Your weekly garage tidy-up</h2>
    <p style="color:#555;margin:0 0 16px">${escapeHtml(r.summary)}</p>
    <table style="width:100%;border-collapse:collapse;font-size:14px">${rows}</table>
    <p style="color:#888;font-size:12px;margin-top:16px">From Tool Vision · open the app and tap Sort to act on these.</p>
  </div>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}

async function sendEmail(subject: string, html: string): Promise<boolean> {
  const base = visionApiUrl();
  if (!base) return false;
  try {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    const email = data.session?.user?.email;
    if (!token || !email) return false;
    const res = await fetch(`${base}/digest`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ to: email, subject, html }),
      signal: AbortSignal.timeout(15000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Run the weekly digest if due. Safe to call on every app open — it self-throttles to once a week and
 * stays silent when there's nothing to organize (so a well-kept garage never gets nagged). Best-effort:
 * a missing connector or unset email key just means that channel is skipped this week.
 */
export async function maybeRunWeeklyDigest(userId: string): Promise<void> {
  if (!userId || !dueForDigest(userId)) return;
  let report: OrgReport;
  try {
    report = await computeOrgReport();
  } catch {
    return; // couldn't analyze — try again next open, don't burn the weekly slot
  }
  // Nothing to surface → mark the week done but send no empty nudge.
  if (report.suggestions.length === 0) { markRun(userId); return; }

  const sendText = async (): Promise<boolean> => {
    if (!(await isConnectorAvailable())) return false;
    const r = await notifyTextViaConnector(textBody(report));
    return !!r?.success;
  };
  const results = await Promise.allSettled([
    sendText(),
    sendEmail("Your weekly garage tidy-up", emailHtml(report)),
  ]);
  // Only consume the weekly slot if at least one channel actually went out — otherwise retry next open.
  const delivered = results.some((x) => x.status === "fulfilled" && x.value === true);
  if (delivered) markRun(userId);
}
