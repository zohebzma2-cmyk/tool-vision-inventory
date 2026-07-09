# Vision service (open-source)

Provides the two endpoints the web app needs (`/map-space`, `/identify-item`) in front of an
open-source vision model. Two interchangeable deployments — the frontend only needs
`VITE_VISION_API_URL` pointed at whichever you run:

- **`worker.js` — Cloudflare Worker (recommended for cloud).** Free to host; calls an open VLM via
  OpenRouter (pay-per-use, ~pennies/image, $0 idle). Rate-limiting + bring-your-own-key built in.
- **`server.mjs` — self-hosted Node adapter.** Zero-dependency; sits in front of a local
  [Ollama](https://ollama.com) model on your own hardware (e.g. a Mac mini) for unlimited, private,
  $0-per-image recognition. Use when you have a spare machine.

Both return identical JSON, so you can start on the Worker and move to self-hosted later with no app
changes.

## Cloud deploy (Cloudflare Worker)

```bash
cd vision-service
npx wrangler secret put OPENROUTER_API_KEY   # paste your OpenRouter key (load ~$5 credit)
npx wrangler deploy
```

Set `VITE_VISION_API_URL` to the deployed Worker URL. Optionally create a KV namespace and
uncomment the `kv_namespaces` block in `wrangler.toml` to cap per-IP daily usage.

## Endpoints

| Method | Path             | Body                        | Returns |
| ------ | ---------------- | --------------------------- | ------- |
| GET    | `/health`        | —                           | `{ ok, model }` |
| POST   | `/map-space`     | `{ imageDataUrl, hint? }`   | `{ type, gridRows, gridCols, notes, confidence }` |
| POST   | `/identify-item` | `{ imageDataUrl }`          | `{ name, category, brand, model, text, confidence, enrichment }` |

### Web-grounded enrichment (`/identify-item`)

After identifying the item, the Worker can make a second OpenRouter call using a text model plus
OpenRouter's [web search plugin](https://openrouter.ai/docs/features/web-search) to add
**current, real-world** info — key specs, typical price, and any active safety recalls — instead of
relying only on the vision model's training data. The result is returned under an `enrichment` key:

```json
{ "specs": "18V, 1/2\" chuck, 500 in-lbs torque", "typicalPrice": "~$99 (kit)",
  "recallNotice": "", "sources": ["https://…", "https://…"] }
```

This is best-effort: if the enrichment call fails or times out it is skipped silently and the base
identification is still returned, with `enrichment: null`. Config (Worker vars):

- `ENABLE_WEB_GROUNDING` — on by default; set to `"false"` to disable the enrichment call.
- `GROUNDING_MODEL` — text model used for grounding (default `google/gemma-4-31b-it:free`).

## One-command setup (Mac mini)

From the repo root on the mini:

```bash
scripts/setup-mac-mini.sh                                  # local only, model auto-picked by RAM
TUNNEL_HOSTNAME=vision.yourdomain.com scripts/setup-mac-mini.sh   # also expose publicly
```

That installs Ollama + the model, runs this adapter as a `launchd` service (survives reboots), and
optionally wires a Cloudflare Tunnel. Point the frontend at it with
`VITE_VISION_API_URL=https://vision.yourdomain.com`.

## Run manually

```bash
VISION_MODEL=qwen2.5vl:7b VISION_PORT=8787 npm start
```

Config: `VISION_PORT` (8787), `OLLAMA_URL` (http://127.0.0.1:11434), `VISION_MODEL` (qwen2.5vl:7b).
Needs Node 18+.
