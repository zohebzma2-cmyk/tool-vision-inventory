# Self-hosted vision on Hetzner (fixed cost, no per-image charges)

For a large library (thousands of tools), pay-per-image API pricing adds up fast. Running an
open-source vision model on a Hetzner box gives you a **flat monthly cost with unlimited
inference**. The frontend and database stay on the free tiers; only the AI moves in-house.

## Which box

Inference speed depends on CPU vs GPU. Identifying ~4,000 tools is mostly a one-time batch, then
occasional lookups — so even a CPU box is viable if you let the batch run over a day or two.

| Option | ~Cost/mo | Model | Speed | Good for |
| ------ | -------- | ----- | ----- | -------- |
| Hetzner CPU dedicated (AX42/AX52, Ryzen) | ~€40-55 | `qwen2.5vl:3b` | ~15-40s/image | Cheapest fixed cost; batch the 4k over a couple days |
| Hetzner CPU dedicated, more RAM | ~€55-70 | `qwen2.5vl:7b` | ~30-60s/image | Better accuracy, still CPU |
| Hetzner GPU (GEX44, RTX 4000 Ada) | ~€200+ | `qwen2.5vl:7b` | ~1-3s/image | Fast; if you want snappy real-time ID |

Recommendation to start: a **CPU dedicated box with `qwen2.5vl:3b`**. Cheap, fixed, and fine for a
mostly one-time labeling pass; upgrade the model or move to GPU later without any app changes
(it's one env var).

## Deploy

On the box (Docker + compose installed, and a DNS A record like `vision.<yourdomain>` -> box IP):

```bash
git clone https://github.com/zohebzma2-cmyk/tool-vision-inventory
cd tool-vision-inventory/vision-service
cp .env.hetzner.example .env         # fill in ALLOWED_ORIGINS + SUPABASE_ANON_KEY
# edit Caddyfile: set your real vision.<yourdomain>
docker compose -f docker-compose.hetzner.yml --env-file .env up -d
docker exec tvi-ollama ollama pull "$(grep VISION_MODEL .env | cut -d= -f2)"
```

Verify: `curl https://vision.<yourdomain>/health` -> `{"ok":true,"model":"qwen2.5vl:3b"}`.

Then point the frontend at it and redeploy:
```bash
# in the repo root, .env:
VITE_VISION_API_URL=https://vision.<yourdomain>
npm run build && wrangler pages deploy dist --project-name tool-vision --branch main
```

## Security

`server.mjs` enforces the same protections as the cloud Worker: CORS locked to `ALLOWED_ORIGINS`
and a valid Supabase user token required (when `SUPABASE_URL` is set). So the public endpoint only
serves signed-in users of your app. Ollama itself is not exposed to the internet (compose keeps it
on the internal network).

## Batch-labeling 4,000 tools

The app identifies one photo at a time through the UI. For a bulk first pass, you can hit the
endpoint directly with a signed-in user's token in a loop (one image at a time so a CPU box keeps
up). Ask and we can add a small `scripts/batch-identify.mjs` that reads a folder of photos and
POSTs each to `/identify-item`, writing results to CSV for review before import.

## Cost comparison

- OpenRouter pay-per-image: ~$0.001-0.005 each. 4,000 tools once ≈ $4-20, but every future
  re-scan/lookup keeps charging.
- Hetzner flat: one predictable monthly bill, unlimited images, and your photos never leave your
  box. This is the better fit once volume is high or ongoing.

Note: the web-grounded enrichment (current specs/price/recalls) still uses OpenRouter's web plugin
and is optional — the local model handles identification and space-mapping with no API cost.
