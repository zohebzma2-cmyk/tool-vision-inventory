# Deploy (free tier)

The whole stack runs free: frontend on **Cloudflare Pages** (`*.pages.dev`), database + auth on
**Supabase free tier**, and AI vision on a **Cloudflare Worker** (`*.workers.dev`) calling free
open-source models via OpenRouter. A custom domain is optional and can be added later.

## 1. Supabase (database + auth)

1. Create a free project at https://supabase.com → note the **Project URL** and **anon key**
   (Settings → API).
2. Apply the migrations in order (SQL editor, paste each file, run):
   - `supabase/migrations/20250808203650_*.sql` … the original schema (if a fresh project)
   - `supabase/migrations/20260709000000_spatial_slots.sql`
   - `supabase/migrations/20260709010000_per_user_rls.sql`
   (Or with the CLI: `supabase link` then `supabase db push`.)
3. Auth → Providers: keep **Email** on; optionally enable **Google** (add a Google OAuth client,
   set the redirect to your Pages URL).

## 2. Frontend (Cloudflare Pages)

1. Cloudflare Dashboard → Pages → Connect the GitHub repo.
2. Build command `npm run build`, output directory `dist`.
3. Environment variables:
   - `VITE_SUPABASE_URL` = your Supabase URL
   - `VITE_SUPABASE_ANON_KEY` = your anon key
   - `VITE_VISION_API_URL` = (fill in after step 3 with the Worker URL)
4. Deploy → note the `https://<project>.pages.dev` URL. SPA routing is handled by `public/_redirects`.

## 3. Vision Worker (Cloudflare)

```bash
cd vision-service
npx wrangler login
npx wrangler secret put OPENROUTER_API_KEY     # paste your OpenRouter key
```

Edit `vision-service/wrangler.toml` vars:
- `ALLOWED_ORIGINS` = your `https://<project>.pages.dev` (and custom domain later)
- `SUPABASE_URL` / `SUPABASE_ANON_KEY` = same as the frontend (lets the Worker verify logins)

(Optional, recommended) enable per-IP rate limiting:
```bash
npx wrangler kv namespace create RATE_LIMIT_KV   # paste the id into wrangler.toml, uncomment the block
```

Deploy:
```bash
npx wrangler deploy                              # note the https://tool-vision.<account>.workers.dev URL
```

## 4. Connect them

Set `VITE_VISION_API_URL` on Cloudflare Pages to the Worker URL, then redeploy the Pages project.

## 5. Verify

- Open the Pages URL → sign up → confirm email → sign in.
- Locations → **Map a Space**: upload a photo → **Map with AI** should return a grid (proves the
  Worker + OpenRouter path). Create the slots; open the slot **map**.
- `curl https://tool-vision.<account>.workers.dev/health` → `{"ok":true,...}`.

## Notes

- Free OpenRouter models are rate-limited. Load ~$5 credit and switch `VISION_MODEL` to
  `qwen/qwen-2.5-vl-7b-instruct` for higher accuracy + headroom.
- Supabase free tier auto-pauses after 7 days idle — the `.github/workflows/keepalive.yml`
  workflow prevents that (set repo secrets `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `VISION_HEALTH_URL`).
- Reliability + monitoring: see `docs/RELIABILITY.md`.

## Custom domain (later)

Register on Cloudflare Registrar (~$10/yr at cost), add it to the Pages project and to
`ALLOWED_ORIGINS`, and (optionally) route the Worker at `vision.<domain>`.
