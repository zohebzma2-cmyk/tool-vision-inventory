// Cloudflare Worker: cloud vision endpoint for Tool Vision Inventory.
//
// Free to host on Cloudflare Workers. Calls an open-source vision model through OpenRouter
// (pay-per-use, ~pennies per image, $0 when idle). Exposes the two routes the web app calls,
// so the frontend only needs VITE_VISION_API_URL pointed at this Worker's URL.
//
//   POST /map-space      { imageDataUrl, hint }  -> { type, gridRows, gridCols, notes, confidence }
//   POST /identify-item  { imageDataUrl }         -> { name, category, brand, model, text, confidence, enrichment }
//   GET  /health                                  -> { ok, model }
//
// Security / reliability hardening:
//   - CORS locked to ALLOWED_ORIGINS (comma-separated). Unset = allow all (dev only).
//   - Requires a valid Supabase user token (verified against /auth/v1/user) when SUPABASE_URL is set,
//     so only signed-in users of YOUR app can spend YOUR OpenRouter credit.
//   - Per-IP daily rate limit via KV (protects credit even from valid users).
//   - Request body size cap.
//   - Retry with backoff + model fallback for uptime.
//   - Bring-your-own-key: header `x-vision-key` uses the caller's key and bypasses auth (self-hosters).
//
// Secrets / vars (wrangler):
//   OPENROUTER_API_KEY (secret) · VISION_MODEL · VISION_MODEL_FALLBACK · OPENROUTER_BASE
//   SUPABASE_URL · SUPABASE_ANON_KEY · ALLOWED_ORIGINS · DAILY_LIMIT · MAX_BODY_BYTES
//   RATE_LIMIT_KV (KV binding, optional)
//   GROUNDING_MODEL (text model for web-grounded enrichment, default "google/gemma-4-31b-it:free")
//   ENABLE_WEB_GROUNDING (default on; set to "false" to disable the enrichment call)

const CATEGORIES = ["hand tools", "power tools", "electrical", "plumbing", "cutting tools", "measuring tools", "fasteners", "other"];
const LOCATION_TYPES = ["pegboard", "drawer", "shelf", "bin", "cabinet", "rack", "board", "wall", "toolbox", "tool bag", "space"];
const DEFAULT_MODEL = "google/gemma-4-31b-it:free";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const allowOrigin = allowed.length === 0 ? "*" : allowed.includes(origin) ? origin : "null";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "content-type, authorization, apikey, x-vision-key",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    Vary: "Origin",
  };
}

const json = (status, obj, cors) =>
  new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });

function parseJson(text) {
  if (!text) return {};
  try { return JSON.parse(text); } catch { /* salvage below */ }
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  if (s !== -1 && e > s) { try { return JSON.parse(text.slice(s, e + 1)); } catch { /* noop */ } }
  return {};
}
const clamp01 = (n) => { const v = Number(n); return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0; };
const clampInt = (n, lo, hi, fb) => { const v = Math.round(Number(n)); return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fb; };

const MAP_PROMPT = (hint) => `You are mapping a physical tool-storage space into a grid of slots.
The photo shows a pegboard, drawer organizer, parts-bin wall, shelf unit, or socket rail.
${hint ? `User hint: "${hint}". Trust it if it conflicts with the image.\n` : ""}Respond with STRICT JSON ONLY:
{"type": one of ${JSON.stringify(LOCATION_TYPES)}, "gridRows": int 1-40, "gridCols": int 1-40, "notes": short string, "confidence": 0..1}`;

const ITEM_KINDS = ["part", "tool", "set", "consumable"];

const IDENTIFY_MANY_PROMPT = `This photo shows the contents of one storage bin in a garage inventory. List EVERY distinct item you can identify. Read visible brand/model text. Group identical items with a count instead of repeating them.
Respond with STRICT JSON ONLY:
{"items": [{"name": short specific name, "category": one of ${JSON.stringify(CATEGORIES)}, "kind": one of ${JSON.stringify(ITEM_KINDS)} (part = component/hardware, tool = works on things, set = multi-piece kit, consumable = gets used up), "brand": string or "", "model": string or "", "quantity": int >= 1, "confidence": 0..1}]}`;

const IDENTIFY_PROMPT = `Identify the single main tool/item in this photo for a garage inventory. Read visible brand/model text.
Respond with STRICT JSON ONLY:
{"name": string, "category": one of ${JSON.stringify(CATEGORIES)}, "brand": string, "model": string, "text": string, "confidence": 0..1}`;

async function callModel(env, apiKey, prompt, imageDataUrl) {
  const base = (env.OPENROUTER_BASE || "https://openrouter.ai/api/v1").replace(/\/$/, "");
  // VISION_MODEL_FALLBACK may be a comma-separated chain; OpenRouter tries each in
  // order, so one upstream-rate-limited free model doesn't take the feature down.
  // OpenRouter rejects more than 3 entries in `models`, so the chain is capped.
  const models = [
    env.VISION_MODEL || DEFAULT_MODEL,
    ...(env.VISION_MODEL_FALLBACK || "").split(",").map((s) => s.trim()).filter(Boolean),
  ].slice(0, 3);
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/zalvi22/tool-vision-inventory",
      "X-Title": "Tool Vision Inventory",
    },
    body: JSON.stringify({
      model: models[0],
      models, // OpenRouter falls back across these in order on error
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: imageDataUrl } }] },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return parseJson(data?.choices?.[0]?.message?.content ?? "{}");
}

async function callModelResilient(env, apiKey, prompt, imageDataUrl) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await callModel(env, apiKey, prompt, imageDataUrl); }
    catch (e) { lastErr = e; await sleep(300 * (attempt + 1)); }
  }
  throw lastErr;
}

const GROUNDING_MODEL = "google/gemma-4-31b-it:free";
const GROUNDING_TIMEOUT_MS = 12000;

const GROUNDING_PROMPT = (name, brand, model) =>
  `Using current web information, enrich this identified tool/item for a garage inventory.
Tool: name="${name || ""}", brand="${brand || ""}", model="${model || ""}".
Search for its key specifications, current typical retail price, and any active safety recalls.
Respond with STRICT JSON ONLY:
{"specs": short string of key specs (e.g. voltage, torque, bit/blade size), "typicalPrice": short string, "recallNotice": string or "", "sources": array of up to 3 URLs}`;

// Optional web-grounded enrichment. Uses a text model + OpenRouter's web search plugin.
// Never throws: on error, timeout, or disabled returns null so identification always succeeds.
async function enrichWithWeb(env, apiKey, ident) {
  if (String(env.ENABLE_WEB_GROUNDING || "").toLowerCase() === "false") return null;
  const base = (env.OPENROUTER_BASE || "https://openrouter.ai/api/v1").replace(/\/$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GROUNDING_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/zalvi22/tool-vision-inventory",
        "X-Title": "Tool Vision Inventory",
      },
      body: JSON.stringify({
        model: env.GROUNDING_MODEL || GROUNDING_MODEL,
        temperature: 0.2,
        response_format: { type: "json_object" },
        plugins: [{ id: "web" }], // OpenRouter web search plugin
        messages: [
          { role: "user", content: GROUNDING_PROMPT(ident.name, ident.brand, ident.model) },
        ],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const out = parseJson(data?.choices?.[0]?.message?.content ?? "{}");
    const sources = Array.isArray(out.sources)
      ? out.sources.filter((s) => typeof s === "string").slice(0, 3)
      : [];
    return {
      specs: typeof out.specs === "string" ? out.specs : "",
      typicalPrice: typeof out.typicalPrice === "string" ? out.typicalPrice : "",
      recallNotice: typeof out.recallNotice === "string" ? out.recallNotice : "",
      sources,
    };
  } catch { /* timeout / network / parse — enrichment must never break identification */
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Verify the request carries a valid Supabase user token (only when SUPABASE_URL configured).
async function verifyUser(env, token) {
  if (!env.SUPABASE_URL) return true; // auth not enforced (dev / self-host without accounts)
  if (!token) return false;
  const r = await fetch(`${env.SUPABASE_URL.replace(/\/$/, "")}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: env.SUPABASE_ANON_KEY || "" },
  });
  return r.ok;
}

async function rateLimited(env, request) {
  if (!env.RATE_LIMIT_KV) return false;
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const limit = Number(env.DAILY_LIMIT || 100);
  const day = new Date().toISOString().slice(0, 10);
  const key = `${ip}:${day}`;
  const count = Number((await env.RATE_LIMIT_KV.get(key)) || 0);
  if (count >= limit) return true;
  await env.RATE_LIMIT_KV.put(key, String(count + 1), { expirationTtl: 172800 });
  return false;
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return json(200, { ok: true, model: env.VISION_MODEL || DEFAULT_MODEL }, cors);
    }

    if (request.method !== "POST" || !["/map-space", "/identify-item", "/identify-bin"].includes(url.pathname)) {
      return json(404, { error: "not found" }, cors);
    }

    // Body size guard (before reading).
    const maxBytes = Number(env.MAX_BODY_BYTES || 8 * 1024 * 1024);
    const declared = Number(request.headers.get("content-length") || 0);
    if (declared && declared > maxBytes) return json(413, { error: "payload too large" }, cors);

    // Auth: a BYOK key bypasses; otherwise require a valid app user token.
    const byok = request.headers.get("x-vision-key");
    const apiKey = byok || env.OPENROUTER_API_KEY;
    if (!apiKey) return json(500, { error: "No API key configured." }, cors);
    if (!byok) {
      const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
      if (!(await verifyUser(env, token))) return json(401, { error: "Sign in required." }, cors);
    }

    if (await rateLimited(env, request)) {
      return json(429, { error: "Daily limit reached. Add your own key via x-vision-key." }, cors);
    }

    const raw = await request.text();
    if (raw.length > maxBytes) return json(413, { error: "payload too large" }, cors);
    const body = parseJson(raw);
    if (!body.imageDataUrl) return json(400, { error: "missing imageDataUrl" }, cors);

    try {
      if (url.pathname === "/map-space") {
        const out = await callModelResilient(env, apiKey, MAP_PROMPT(body.hint || ""), body.imageDataUrl);
        return json(200, {
          type: LOCATION_TYPES.includes(String(out.type)) ? out.type : "space",
          gridRows: clampInt(out.gridRows, 1, 40, 4),
          gridCols: clampInt(out.gridCols, 1, 40, 4),
          notes: typeof out.notes === "string" ? out.notes : "",
          confidence: clamp01(out.confidence ?? 0.6),
        }, cors);
      }
      if (url.pathname === "/identify-bin") {
        const out = await callModelResilient(env, apiKey, IDENTIFY_MANY_PROMPT, body.imageDataUrl);
        const items = (Array.isArray(out.items) ? out.items : []).slice(0, 40).map((it) => {
          const cat = String(it?.category || "").toLowerCase();
          const kind = String(it?.kind || "").toLowerCase();
          return {
            name: typeof it?.name === "string" && it.name.trim() ? it.name.trim() : "Unknown item",
            category: CATEGORIES.includes(cat) ? cat : "other",
            kind: ITEM_KINDS.includes(kind) ? kind : "part",
            brand: typeof it?.brand === "string" ? it.brand : "",
            model: typeof it?.model === "string" ? it.model : "",
            quantity: clampInt(it?.quantity, 1, 999, 1),
            confidence: clamp01(it?.confidence ?? 0.6),
          };
        });
        return json(200, { items }, cors);
      }

      const out = await callModelResilient(env, apiKey, IDENTIFY_PROMPT, body.imageDataUrl);
      const cat = String(out.category || "").toLowerCase();
      const ident = {
        name: typeof out.name === "string" ? out.name : "Unknown item",
        category: CATEGORIES.includes(cat) ? cat : "other",
        brand: typeof out.brand === "string" ? out.brand : "",
        model: typeof out.model === "string" ? out.model : "",
        text: typeof out.text === "string" ? out.text : "",
        confidence: clamp01(out.confidence ?? 0.6),
      };
      // Optional web-grounded enrichment — never allowed to break identification.
      const enrichment = await enrichWithWeb(env, apiKey, ident);
      return json(200, { ...ident, enrichment }, cors);
    } catch (e) {
      return json(502, { error: String(e?.message || e) }, cors);
    }
  },

  // Daily cron ([triggers] in wrangler.toml): pings Supabase REST so the free-tier project
  // registers activity and never hits the 7-day auto-pause. Runs on Cloudflare's scheduler —
  // no GitHub Actions or external cron needed. Throws on a non-2xx response so failed runs
  // surface in the Cloudflare dashboard (Workers -> tool-vision -> Cron Events).
  async scheduled(event, env) {
    const base = (env.SUPABASE_URL || "").replace(/\/+$/, "");
    if (!base) return; // keepalive only matters when a Supabase project is configured
    const res = await fetch(`${base}/rest/v1/`, {
      headers: { apikey: env.SUPABASE_ANON_KEY || "" },
    });
    if (!res.ok) throw new Error(`Supabase keepalive ping failed: HTTP ${res.status}`);
  },
};
