# Reliability and Uptime

This document describes the failure domains of Tool Vision Inventory, the
mitigations already in place, recommended external monitoring, graceful
degradation behavior, and the service-level objectives (SLOs) we target.

## Architecture and failure domains

The app has three independent pieces:

1. **React frontend (Cloudflare Pages).**
   Static assets served from Cloudflare's edge CDN. This is the most reliable
   layer: there is no server to crash, and Cloudflare Pages historically runs at
   effectively 100% availability. A failure here would be a broad Cloudflare
   incident, which is rare and outside our control.

2. **Vision Worker (Cloudflare Worker).**
   `vision-service/worker.js`, deployed to Cloudflare Workers, runs on the same
   edge network. It calls open-source vision models through OpenRouter.
   - **Single external dependency: OpenRouter.** If OpenRouter or the chosen
     model is unavailable, image analysis can fail. This is already mitigated
     inside the Worker by **retry with backoff plus model fallback**
     (`VISION_MODEL` -> `VISION_MODEL_FALLBACK`), so a single failing model or a
     transient error does not immediately break identification. The optional
     web-grounding enrichment call is best-effort and returns `null` on any
     error, so enrichment never breaks core identification.
   - The Worker has no database of its own and is stateless (aside from an
     optional KV namespace used only for per-IP rate limiting), so it has no
     persistent state to corrupt.

3. **Supabase (Postgres + Auth), free tier.**
   Stores user data and handles authentication.
   - **Free-tier auto-pause.** A Supabase free-tier project is automatically
     paused after **7 days of inactivity**. For a public tool this is a real
     availability risk: an idle stretch would leave sign-in and data reads
     failing until the project is manually resumed.
   - **Mitigation (primary):** the vision Worker's daily **cron trigger**
     (`[triggers]` in `vision-service/wrangler.toml` plus the `scheduled`
     handler in `worker.js`) pings the Supabase REST endpoint once per day,
     which counts as activity and keeps the project awake. Cron triggers run on
     Cloudflare's scheduler and reuse the Worker's existing `SUPABASE_URL` /
     `SUPABASE_ANON_KEY` secrets — no extra configuration, no dependency on
     GitHub Actions availability. Failed runs appear under the Worker's
     **Cron Events** in the Cloudflare dashboard.
   - **Mitigation (alternative):** the scheduled GitHub Actions workflow
     `.github/workflows/keepalive.yml` does the same daily ping. Use it if you
     deploy the frontend without the Worker, or as a second, independent
     pinger. Note it silently stops protecting you if Actions is unavailable
     on your account (e.g. a billing lock), so verify runs are actually green.
   - **Permanent fix:** upgrading to **Supabase Pro ($25/month)** removes the
     inactivity auto-pause entirely. The keepalive pings are the free-tier
     workaround; Pro is the recommended path once the tool has steady traffic.

## Worker /health endpoint

The Worker exposes a health route:

```
GET /health  ->  200 { "ok": true, "model": "<active vision model>" }
```

It is unauthenticated and cheap (it does not call OpenRouter), so it is safe to
poll frequently from monitors. A non-2xx response, a timeout, or a connection
failure indicates the Worker is down or misconfigured.

## Recommended external monitoring

The daily keepalive workflow is a coarse, once-a-day check. For faster outage
detection, add an external uptime monitor such as **UptimeRobot** or **Cronitor**
(both have usable free tiers) with a **5-minute interval** on:

- the Worker health URL: `https://<your-worker-host>/health`
- the app URL: `https://<your-pages-host>/`

Configure alerts (email/Slack) so an outage pages a human rather than waiting for
the next daily workflow run. The `vision-service/monitor.sh` script can also be
run ad hoc or from your own cron to check both endpoints from the command line.

## Graceful degradation

The app is designed to remain fully usable when vision is unavailable. When the
vision service is not configured or is failing, `src/lib/vision.ts` surfaces a
`VisionNotConfiguredError` and callers fall back to **fully manual entry**, so
users can still create locations and catalog tools by hand. Image
identification is an enhancement, not a hard dependency. This means a vision or
OpenRouter outage degrades the experience (no auto-fill from photos) but does not
take the app offline.

## SLO targets

These are intentionally simple, honest targets for a small public tool:

| Component            | Target                | Notes                                                        |
| -------------------- | --------------------- | ------------------------------------------------------------ |
| App availability     | 99.5% monthly         | Frontend + auth + data reads. Bounded mainly by Supabase.    |
| Vision analysis      | Best-effort           | Depends on OpenRouter/model availability; manual entry always works. |
| Worker /health       | Matches Cloudflare    | Stateless edge; expected to track Cloudflare's uptime.       |

99.5% monthly availability allows roughly 3.6 hours of downtime per 30-day
month. Vision is deliberately best-effort: because the app degrades gracefully
to manual entry, a vision outage is a reduced-quality window, not an outage of
the tool itself.
