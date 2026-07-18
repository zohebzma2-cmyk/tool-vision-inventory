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

/** Pull complete {...} spot objects out of a possibly-truncated grounding array. */
/** Intersection-over-union of two normalized boxes. */
function iou(a, b) {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

function salvageSpots(text) {
  const spots = [];
  const re = /\{\s*"label"\s*:\s*"([^"]*)"\s*,\s*"bbox_1000"\s*:\s*\[([^\]]*)\](?:\s*,\s*"confidence"\s*:\s*([0-9.]+))?\s*\}/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const nums = m[2].split(",").map((n) => Number(n.trim()));
    if (nums.length === 4 && nums.every(Number.isFinite)) {
      spots.push({ label: m[1], bbox_1000: nums, confidence: m[3] === undefined ? 0.6 : Number(m[3]) });
    }
  }
  return spots;
}

function parseJson(text) {
  if (!text) return {};
  try { return JSON.parse(text); } catch { /* salvage below */ }
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  if (s !== -1 && e > s) { try { return JSON.parse(text.slice(s, e + 1)); } catch { /* noop */ } }
  const salvaged = salvageSpots(text);
  if (salvaged.length) return { spots: salvaged, __salvaged: salvaged };
  return {};
}
const clamp01 = (n) => { const v = Number(n); return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0; };
const clampInt = (n, lo, hi, fb) => { const v = Math.round(Number(n)); return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fb; };
const clampNum = (n, lo, hi, fb) => { const v = Number(n); return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fb; };

const ZONE_MIN = 0.05; // smallest zone as a fraction of the room (matches the editor)

/** Sanitize a model's blueprint draft into the exact { roomFt, zones } shape the app renders. */
function normalizeBlueprint(out) {
  const w = clampNum(out?.roomFt?.w, 1, 200, 20);
  const d = clampNum(out?.roomFt?.d, 1, 200, 20);
  const rawZones = Array.isArray(out?.zones) ? out.zones : [];
  const zones = rawZones.slice(0, 20).map((z, i) => {
    const type = ZONE_TYPES.includes(String(z?.type)) ? z.type : "shelf";
    const rx = clamp01(z?.rect?.x), ry = clamp01(z?.rect?.y);
    const rw = Math.max(ZONE_MIN, clamp01(z?.rect?.w));
    const rh = Math.max(ZONE_MIN, clamp01(z?.rect?.h));
    // Keep the zone inside the room: pull the corner back if it would overflow.
    const x = Math.min(rx, 1 - rw), y = Math.min(ry, 1 - rh);
    const name = typeof z?.name === "string" && z.name.trim() ? z.name.trim() : `Zone ${i + 1}`;
    return { name, type, rect: { x, y, w: rw, h: rh } };
  });
  return { roomFt: { w, d }, zones };
}

const MAP_PROMPT = (hint) => `You are mapping a physical tool-storage space into a grid of slots.
The photo shows a pegboard, drawer organizer, parts-bin wall, shelf unit, or socket rail.
${hint ? `User hint: "${hint}". Trust it if it conflicts with the image.\n` : ""}Respond with STRICT JSON ONLY:
{"type": one of ${JSON.stringify(LOCATION_TYPES)}, "gridRows": int 1-40 (count of horizontal rows, top to bottom), "gridCols": int 1-40 (count of vertical columns, left to right), "region": {"x": 0..1, "y": 0..1, "w": 0..1, "h": 0..1} tight bounding box of ONLY the storage unit within the image (normalized to image size), "notes": short string, "confidence": 0..1}`;

const ITEM_KINDS = ["part", "tool", "set", "consumable"];

const IDENTIFY_MANY_PROMPT = `This photo shows the contents of one storage bin/tote in a garage inventory. List EVERY distinct item you can identify. Read visible brand/model text. Group identical items with a count instead of repeating them.
For PARTS, FITTINGS, and HARDWARE (pipe/PVC/brass fittings, irrigation heads & nozzles, sprinkler bodies, valves, screws/bolts/nuts, washers, electrical connectors, adapters, elbows, tees, couplings), capture the SIZE/SPEC in the "size" field — read it from any printed marking, and otherwise estimate from proportions. Use the trade's normal notation, e.g. "3/4 in", "1/2 in MPT", "1 in slip", "#8 x 1-1/2 in", "4 in pop-up", "5000 series 3.0 GPM", "12 AWG". Be accurate; if you genuinely can't tell, use "".
Also estimate the tote's size from visual cues (the bin walls, proportions, and any items of known scale) and write one short general phrase describing what the bin holds overall.
Respond with STRICT JSON ONLY:
{"items": [{"name": short specific name, "category": one of ${JSON.stringify(CATEGORIES)}, "kind": one of ${JSON.stringify(ITEM_KINDS)} (part = component/hardware, tool = works on things, set = multi-piece kit, consumable = gets used up), "size": size/spec string or "" (e.g. "3/4 in", "1/2 in MPT", "4 in pop-up"), "brand": string or "", "model": string or "", "quantity": int >= 1, "confidence": 0..1}], "tote": {"sizeGuess": one of ["small","medium","large"], "gallonsGuess": number 1-55}, "summary": short phrase (<= 8 words) describing the bin's overall contents}`;

const DETECT_SPOTS_PROMPT = `Locate EVERY distinct physical item in this tool-storage photo: each tool, bin, box, bag, or piece of equipment gets its OWN tight bounding box — these become labeled storage spots. Use pixel-style coordinates on a 0-1000 scale: [x1, y1, x2, y2].
Respond with STRICT JSON ONLY:
{"spots": [{"label": short specific name, "bbox_1000": [x1, y1, x2, y2], "confidence": 0..1}]}`;

const IDENTIFY_PROMPT = `Identify the single main tool/item in this photo for a garage inventory. Read visible brand/model text.
Respond with STRICT JSON ONLY:
{"name": string, "category": one of ${JSON.stringify(CATEGORIES)}, "brand": string, "model": string, "text": string, "confidence": 0..1}`;

const CABLE_PROMPT = `You are looking at a coiled / wrapped-up cable or cord for a garage inventory. Estimate its length from the coil — count the visible loops and judge the loop diameter (length ≈ loops × loop circumference). Coil-based length is approximate, so also give a min/max range. Read any printed length/gauge text on the jacket if visible. Respond with STRICT JSON ONLY:
{"type": short type (e.g. "extension cord","power cable","USB-C cable","HDMI cable","ethernet cable","air hose","garden hose","rope"), "lengthFeet": number best estimate of TOTAL length in feet, "lengthMin": number, "lengthMax": number, "gauge": string or "" (e.g. "14 AWG"), "connectors": string or "" (e.g. "NEMA 5-15 both ends"), "color": string or "", "confidence": 0..1}`;

// Blueprint zones are a subset of location types — the furniture strips that live inside a room.
const ZONE_TYPES = ["pegboard", "shelf", "cabinet", "rack", "drawer", "bin"];

const BLUEPRINT_PROMPT = (description) => `You are drafting a to-scale, top-down floor plan (blueprint) of a garage or workshop for a tool-inventory app.
${description ? `The user describes the space: "${description}".\n` : `A hand-drawn sketch of the space is provided. Read its rooms, walls, and labeled storage.\n`}Lay out the room as a rectangle (width x depth in FEET) and place labeled storage zones against the walls. Each zone is one piece of storage furniture.
Respond with STRICT JSON ONLY:
{"roomFt": {"w": number feet 1-200, "d": number feet 1-200}, "zones": [{"name": short label (e.g. "North pegboard"), "type": one of ${JSON.stringify(ZONE_TYPES)}, "rect": {"x": 0..1, "y": 0..1, "w": 0..1, "h": 0..1}}]}
Coordinates are normalized to the room footprint: x,y = top-left corner (0,0 = back-left), w,h = size as a fraction of room width/depth. Push zones flush against walls the way real storage sits. Include only storage the user mentions or that is drawn; do not invent a full room of furniture. Max 20 zones.`;

async function callProvider(base, key, models, prompt, imageDataUrl, timeoutMs, opts = {}) {
  const isOpenRouter = base.includes("openrouter.ai");
  const res = await fetch(`${base.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/zohebzma2-cmyk/tool-vision-inventory",
      "X-Title": "Tool Vision Inventory",
    },
    body: JSON.stringify({
      model: models[0],
      ...(models.length > 1 ? { models } : {}), // OpenRouter-style in-request fallback
      // Some OpenRouter providers silently DROP images (observed: Parasail) — exclude them.
      ...(isOpenRouter ? { provider: { ignore: ["Parasail"] } } : {}),
      temperature: 0.2,
      ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
      // Grounding prompts work better without forced json_object on some hosts.
      ...(opts.noJsonMode ? {} : { response_format: { type: "json_object" } }),
      messages: [
        {
          role: "user",
          // Text-only calls (e.g. a described-but-not-photographed blueprint) omit the image part.
          content: imageDataUrl
            ? [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: imageDataUrl } }]
            : prompt,
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Vision provider ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return parseJson(data?.choices?.[0]?.message?.content ?? "{}");
}

/** Providers in quality order. VISION_PRIMARY chooses the lead brain:
 *  - "cloud": paid open model on OpenRouter (Qwen3-VL) first — fast + best quality —
 *    then the self-hosted box, then the free chain
 *  - anything else: self-hosted box first (flat cost), free chain as fallback */
function providers(env, apiKey, overrideModel) {
  const list = [];
  const orBase = env.OPENROUTER_BASE || "https://openrouter.ai/api/v1";
  const selfHosted = env.SELF_VISION_BASE && env.SELF_VISION_KEY
    ? {
        base: env.SELF_VISION_BASE,
        key: env.SELF_VISION_KEY,
        models: [env.SELF_VISION_MODEL || "qwen2.5vl:7b"],
        retries: 1,
        timeoutMs: 120000, // CPU inference on the box is slow but bounded
      }
    : null;

  if (env.VISION_PRIMARY === "cloud") {
    list.push({
      base: orBase,
      key: apiKey,
      // Grounding (box output) uses a different model: the 235B reliably returns an empty
      // list when asked for boxes, while the 30B-A3B grounds well. Everything else keeps
      // the 235B, which is the stronger reader/identifier.
      models: [overrideModel || env.VISION_MODEL_PAID || "qwen/qwen3-vl-235b-a22b-instruct"],
      retries: 1,
      timeoutMs: 90000,
    });
  }
  if (selfHosted) list.push(selfHosted);
  list.push({
    base: orBase,
    key: apiKey,
    models: [
      env.VISION_MODEL || DEFAULT_MODEL,
      ...(env.VISION_MODEL_FALLBACK || "").split(",").map((s) => s.trim()).filter(Boolean),
    ].slice(0, 3), // OpenRouter rejects more than 3 entries
    retries: 2,
    timeoutMs: 60000,
  });
  return list;
}

async function callModelResilient(env, apiKey, prompt, imageDataUrl, opts = {}) {
  let lastErr;
  for (const p of providers(env, apiKey, opts.model)) {
    for (let attempt = 0; attempt <= p.retries; attempt++) {
      try { return await callProvider(p.base, p.key, p.models, prompt, imageDataUrl, p.timeoutMs, opts); }
      catch (e) { lastErr = e; await sleep(300 * (attempt + 1)); }
    }
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
        "HTTP-Referer": "https://github.com/zohebzma2-cmyk/tool-vision-inventory",
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

// Resolve the signed-in user (with their verified email) from a Supabase token — used by /digest so
// the digest can ONLY ever be emailed to the requester's own address (never an attacker-chosen one).
async function getUser(env, token) {
  if (!env.SUPABASE_URL || !token) return null;
  const r = await fetch(`${env.SUPABASE_URL.replace(/\/$/, "")}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: env.SUPABASE_ANON_KEY || "" },
  });
  if (!r.ok) return null;
  return await r.json().catch(() => null);
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
      return json(200, {
        ok: true,
        model: env.VISION_PRIMARY === "cloud"
          ? `${env.VISION_MODEL_PAID || "qwen/qwen3-vl-235b-a22b-instruct"} (cloud primary)`
          : env.SELF_VISION_BASE
            ? `${env.SELF_VISION_MODEL || "qwen2.5vl:7b"} (self-hosted)`
            : (env.VISION_MODEL || DEFAULT_MODEL),
      }, cors);
    }

    // In-app agent chat. Thin, stateless proxy: the client sends the full message history + tool
    // schemas; we forward to the LLM and return the assistant message verbatim (including any
    // tool_calls). The CLIENT runs the tool-calling loop and executes tools against Supabase with the
    // signed-in user's own token — writes are confirmed in the UI — so this endpoint never touches
    // inventory data or holds state. Auth-gated + rate-limited like the vision routes.
    if (request.method === "POST" && url.pathname === "/chat") {
      const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
      if (!(await verifyUser(env, token))) return json(401, { error: "unauthorized" }, cors);
      if (await rateLimited(env, request)) return json(429, { error: "rate limited" }, cors);
      let body;
      try { body = await request.json(); } catch { return json(400, { error: "bad json" }, cors); }
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const tools = Array.isArray(body.tools) && body.tools.length ? body.tools : undefined;
      if (!messages.length) return json(400, { error: "no messages" }, cors);
      const base = (env.OPENROUTER_BASE || "https://openrouter.ai/api/v1").replace(/\/$/, "");
      const primary = env.CHAT_MODEL || env.VISION_MODEL_PAID || "qwen/qwen3-vl-235b-a22b-instruct";
      const fb = env.VISION_MODEL_PAID || "qwen/qwen3-vl-235b-a22b-instruct";
      const tryChat = (model) => fetch(`${base}/chat/completions`, {
        method: "POST",
        signal: AbortSignal.timeout(60000),
        headers: {
          Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://github.com/zohebzma2-cmyk/tool-vision-inventory",
          "X-Title": "Tool Vision Inventory",
        },
        body: JSON.stringify({
          model,
          provider: { ignore: ["Parasail"] }, // this provider silently drops images
          temperature: 0.3,
          max_tokens: 900,
          messages,
          ...(tools ? { tools, tool_choice: "auto" } : {}),
        }),
      });
      try {
        // Try the preferred chat model; if it's unavailable (e.g. no account access, outage), fall
        // back to the known-good vision model so the assistant always answers.
        let res = await tryChat(primary);
        if (!res.ok && primary !== fb) res = await tryChat(fb);
        if (!res.ok) return json(502, { error: `chat provider ${res.status}: ${(await res.text()).slice(0, 300)}` }, cors);
        const data = await res.json();
        const message = data?.choices?.[0]?.message ?? { role: "assistant", content: "" };
        return json(200, { message }, cors);
      } catch (e) {
        return json(500, { error: String(e?.message || e) }, cors);
      }
    }

    // Brand-logo lookup (logos.dev): resolve a brand name → its domain using the SECRET key server-
    // side; the client then builds the public image URL with the publishable key. Auth-gated; the
    // client caches results so this is hit at most once per brand.
    if (request.method === "GET" && url.pathname === "/brand-logo") {
      const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
      if (!(await verifyUser(env, token))) return json(401, { error: "Sign in required." }, cors);
      if (!env.LOGODEV_SECRET_KEY) return json(503, { error: "logos not configured" }, cors);
      const q = (url.searchParams.get("q") || "").trim();
      if (!q) return json(400, { error: "missing q" }, cors);
      try {
        const r = await fetch(`https://api.logo.dev/search?q=${encodeURIComponent(q)}`, {
          headers: { Authorization: `Bearer ${env.LOGODEV_SECRET_KEY}` },
          signal: AbortSignal.timeout(8000),
        });
        if (!r.ok) return json(502, { error: `logo search ${r.status}` }, cors);
        const arr = await r.json();
        const top = Array.isArray(arr) ? arr[0] : null;
        return json(200, top && top.domain ? { domain: top.domain, name: top.name || q } : { domain: null }, cors);
      } catch {
        return json(502, { error: "logo lookup failed" }, cors);
      }
    }

    // Weekly organization digest email (client-triggered): the signed-in app posts its own report as
    // ready-to-send HTML; we relay it via Resend. Kept separate from the vision routes — no image, no
    // OpenRouter key. No-ops with 503 until RESEND_API_KEY is set, so the client just skips email.
    if (request.method === "POST" && url.pathname === "/digest") {
      const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
      // Recipient is the AUTHENTICATED user's own email, resolved server-side — never taken from the
      // request body. Prevents this endpoint being used as an open relay to email arbitrary victims
      // from the shared Resend domain (which would also risk blacklisting the other apps on that key).
      const user = await getUser(env, token);
      if (!user?.email) return json(401, { error: "Sign in required." }, cors);
      if (!env.RESEND_API_KEY) return json(503, { error: "email not configured" }, cors);
      // Cap the body so a large HTML payload can't be relayed through the shared account.
      if (Number(request.headers.get("content-length") || 0) > 256 * 1024) return json(413, { error: "too large" }, cors);
      const body = parseJson(await request.text());
      const to = user.email;
      const subject = typeof body.subject === "string" && body.subject ? body.subject.slice(0, 200) : "Your weekly garage tidy-up";
      const html = typeof body.html === "string" ? body.html.slice(0, 200_000) : "";
      if (!html) return json(400, { error: "missing html" }, cors);
      const from = env.DIGEST_FROM || "Tool Vision <onboarding@resend.dev>";
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from, to, subject, html }),
      });
      if (!r.ok) {
        const detail = await r.text().catch(() => "");
        return json(502, { error: `resend ${r.status}`, detail: detail.slice(0, 200) }, cors);
      }
      return json(200, { ok: true }, cors);
    }

    // SKU / barcode lookup: resolve a UPC/EAN to a product (name/brand/category) so scanning a
    // printed barcode can auto-fill a new item. Proxied server-side (no browser CORS). Auth-gated.
    if (request.method === "POST" && url.pathname === "/sku-lookup") {
      const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
      if (!(await verifyUser(env, token))) return json(401, { error: "Sign in required." }, cors);
      const upc = String(parseJson(await request.text()).upc || "").trim();
      if (!/^\d{8}$|^\d{12,13}$/.test(upc)) return json(400, { error: "invalid barcode" }, cors);
      try {
        // UPCitemdb has a free (keyless, rate-limited) trial endpoint; a paid key can be added later
        // as SKU_LOOKUP_URL/SKU_LOOKUP_KEY without touching the client.
        const r = await fetch(`https://api.upcitemdb.com/prod/trial/lookup?upc=${encodeURIComponent(upc)}`, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(10000),
        });
        if (!r.ok) return json(502, { error: `lookup ${r.status}` }, cors);
        const data = await r.json();
        const it = (data.items || [])[0];
        if (!it || !it.title) return json(404, { error: "no match" }, cors);
        // UPCitemdb category is a "A > B > C" path — the leaf is the most useful single category.
        const category = String(it.category || "").split(">").pop().trim();
        return json(200, {
          title: String(it.title).trim(),
          brand: String(it.brand || "").trim(),
          model: String(it.model || "").trim(),
          category,
          upc,
        }, cors);
      } catch (e) {
        return json(502, { error: "lookup failed" }, cors);
      }
    }

    if (request.method !== "POST" || !["/map-space", "/identify-item", "/identify-cable", "/identify-bin", "/detect-spots", "/generate-blueprint"].includes(url.pathname)) {
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
    // Every route needs an image EXCEPT /generate-blueprint, which also accepts a text description.
    const hasDescription = typeof body.description === "string" && body.description.trim();
    if (!body.imageDataUrl && !(url.pathname === "/generate-blueprint" && hasDescription)) {
      return json(400, { error: "missing imageDataUrl" }, cors);
    }

    try {
      if (url.pathname === "/generate-blueprint") {
        const out = await callModelResilient(
          env, apiKey,
          BLUEPRINT_PROMPT(hasDescription ? body.description.trim() : ""),
          body.imageDataUrl || null,
        );
        return json(200, normalizeBlueprint(out), cors);
      }
      if (url.pathname === "/map-space") {
        const out = await callModelResilient(env, apiKey, MAP_PROMPT(body.hint || ""), body.imageDataUrl);
        const r = out.region;
        const region = r && typeof r === "object"
          ? { x: clamp01(r.x), y: clamp01(r.y), w: clamp01(r.w), h: clamp01(r.h) }
          : null;
        return json(200, {
          type: LOCATION_TYPES.includes(String(out.type)) ? out.type : "space",
          gridRows: clampInt(out.gridRows, 1, 40, 4),
          gridCols: clampInt(out.gridCols, 1, 40, 4),
          region,
          notes: typeof out.notes === "string" ? out.notes : "",
          confidence: clamp01(out.confidence ?? 0.6),
        }, cors);
      }
      if (url.pathname === "/detect-spots") {
        const out = await callModelResilient(env, apiKey, DETECT_SPOTS_PROMPT, body.imageDataUrl, {
          noJsonMode: true,
          maxTokens: 4000, // enough for a dense wall; salvage recovers truncated tails
          model: env.VISION_MODEL_GROUNDING || "qwen/qwen3-vl-30b-a3b-instruct",
        });
        const raw = Array.isArray(out.spots) ? out.spots : [];
        const seen = new Set();
        const spots = raw.slice(0, 120).flatMap((sp) => {
          const bb = Array.isArray(sp?.bbox_1000) ? sp.bbox_1000.map(Number) : null;
          if (!bb || bb.length !== 4 || bb.some((n) => !Number.isFinite(n))) return [];
          const [x1, y1, x2, y2] = bb;
          const x = clamp01(Math.min(x1, x2) / 1000), y = clamp01(Math.min(y1, y2) / 1000);
          const w = clamp01(Math.abs(x2 - x1) / 1000), h = clamp01(Math.abs(y2 - y1) / 1000);
          if (w < 0.005 || h < 0.005) return [];
          const conf = clamp01(sp?.confidence ?? 0.6);
          if (conf < 0.2) return []; // models pad truncated lists with 0.0-confidence junk
          const key = `${Math.round(x * 200)}:${Math.round(y * 200)}:${Math.round(w * 200)}:${Math.round(h * 200)}`;
          if (seen.has(key)) return []; // identical repeated boxes
          seen.add(key);
          return [{
            label: typeof sp?.label === "string" && sp.label.trim() ? sp.label.trim() : "Spot",
            box: { x, y, w, h },
            confidence: conf,
          }];
        });
        // Non-max suppression: models emit several boxes per object; keep the most
        // confident and drop anything overlapping it heavily.
        const kept = [];
        for (const sp of spots.sort((a, b) => b.confidence - a.confidence)) {
          if (!kept.some((k) => iou(k.box, sp.box) > 0.45)) kept.push(sp);
          if (kept.length >= 60) break;
        }
        return json(200, { spots: kept }, cors);
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
        // Tote-size estimate + summary (for Sort-a-bin). Rough by design — the user confirms size.
        const TOTE_SIZES = ["small", "medium", "large"];
        const sizeGuess = TOTE_SIZES.includes(String(out?.tote?.sizeGuess)) ? out.tote.sizeGuess : null;
        const gallonsGuess = out?.tote?.gallonsGuess != null
          ? clampNum(out.tote.gallonsGuess, 1, 55, 12)
          : null;
        const summary = typeof out?.summary === "string" ? out.summary.trim().slice(0, 80) : "";
        return json(200, { items, tote: (sizeGuess || gallonsGuess) ? { sizeGuess, gallonsGuess } : null, summary }, cors);
      }

      if (url.pathname === "/identify-cable") {
        const out = await callModelResilient(env, apiKey, CABLE_PROMPT, body.imageDataUrl);
        return json(200, {
          type: typeof out.type === "string" ? out.type.slice(0, 40) : "cable",
          lengthFeet: clampNum(out.lengthFeet, 0.5, 500, 10),
          lengthMin: out.lengthMin != null ? clampNum(out.lengthMin, 0.5, 500, 5) : null,
          lengthMax: out.lengthMax != null ? clampNum(out.lengthMax, 0.5, 500, 25) : null,
          gauge: typeof out.gauge === "string" ? out.gauge.slice(0, 20) : "",
          connectors: typeof out.connectors === "string" ? out.connectors.slice(0, 60) : "",
          color: typeof out.color === "string" ? out.color.slice(0, 20) : "",
          confidence: clamp01(out.confidence ?? 0.5),
        }, cors);
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

  // Two crons ([triggers] in wrangler.toml):
  //  - daily: pings Supabase REST so the free-tier project never hits the 7-day auto-pause
  //  - every minute: a 1-token request — the proxy pins keep_alive to ~90s, so only a to the self-hosted vision model so Ollama keeps it
  //    1-minute cadence actually keeps the model resident (warm ~10s, cold ~3min)
  async scheduled(event, env) {
    if (event.cron === "* * * * *") {
      if (!env.SELF_VISION_BASE || !env.SELF_VISION_KEY) return;
      await fetch(`${env.SELF_VISION_BASE.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        signal: AbortSignal.timeout(25000),
        headers: { Authorization: `Bearer ${env.SELF_VISION_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: env.SELF_VISION_MODEL || "qwen2.5vl:7b",
          max_tokens: 1,
          messages: [{ role: "user", content: "ok" }],
        }),
      }).catch(() => {}); // best-effort — a missed warm-up just means one slow request later
      return;
    }
    const base = (env.SUPABASE_URL || "").replace(/\/+$/, "");
    if (!base) return; // keepalive only matters when a Supabase project is configured
    const res = await fetch(`${base}/rest/v1/`, {
      headers: { apikey: env.SUPABASE_ANON_KEY || "" },
    });
    if (!res.ok) throw new Error(`Supabase keepalive ping failed: HTTP ${res.status}`);
  },
};
