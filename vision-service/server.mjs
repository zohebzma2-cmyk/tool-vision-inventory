// Self-hosted vision adapter for Tool Vision Inventory.
//
// Zero external dependencies — uses only Node built-ins (needs Node 18+ for global fetch).
// It sits in front of a local Ollama instance running an open-source vision model
// (default qwen2.5vl) and exposes the two endpoints the web app calls:
//   POST /map-space      { imageDataUrl, hint }      -> { type, gridRows, gridCols, slotNames?, notes, confidence }
//   POST /identify-item  { imageDataUrl }            -> { name, category, brand, model, text, confidence }
//   GET  /health                                     -> { ok: true, model }
//
// Config via env:
//   VISION_PORT   (default 8787)
//   OLLAMA_URL    (default http://127.0.0.1:11434)
//   VISION_MODEL  (default qwen2.5vl:7b)

import { createServer } from "node:http";

const PORT = Number(process.env.VISION_PORT || 8787);
const OLLAMA_URL = (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
const MODEL = process.env.VISION_MODEL || "qwen2.5vl:7b";

const CATEGORIES = [
  "hand tools",
  "power tools",
  "electrical",
  "plumbing",
  "cutting tools",
  "measuring tools",
  "fasteners",
  "other",
];

const LOCATION_TYPES = [
  "pegboard",
  "drawer",
  "shelf",
  "bin",
  "cabinet",
  "rack",
  "board",
  "wall",
  "space",
];

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

/** Strip a data URL prefix and return raw base64. */
function toBase64(imageDataUrl) {
  if (typeof imageDataUrl !== "string") return "";
  const comma = imageDataUrl.indexOf(",");
  return imageDataUrl.startsWith("data:") && comma !== -1
    ? imageDataUrl.slice(comma + 1)
    : imageDataUrl;
}

/** Tolerant JSON parse: handles code fences and surrounding prose. */
function parseJson(text) {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        /* fall through */
      }
    }
    return {};
  }
}

function clamp01(n) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
}

function clampInt(n, lo, hi, fallback) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return fallback;
  return Math.max(lo, Math.min(hi, v));
}

/** Call Ollama's chat API with one image and a JSON-only instruction. */
async function askModel(prompt, base64Image) {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      format: "json",
      options: { temperature: 0.2 },
      messages: [
        {
          role: "user",
          content: prompt,
          images: base64Image ? [base64Image] : [],
        },
      ],
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Ollama ${res.status}: ${detail.slice(0, 300)}`);
  }
  const data = await res.json();
  return parseJson(data?.message?.content ?? "{}");
}

const MAP_PROMPT = (hint) => `You are helping map a physical tool-storage space into a grid of slots.
Look at the photo. It shows a storage space such as a pegboard, a drawer organizer, a parts-bin wall,
a shelf unit, or a socket rail. Estimate how it is divided into a regular grid.

${hint ? `User hint: "${hint}". Trust the hint if it conflicts with the image.\n` : ""}
Respond with STRICT JSON ONLY, no prose:
{
  "type": string,        // one of ${JSON.stringify(LOCATION_TYPES)}
  "gridRows": number,    // integer number of rows you see (1-40)
  "gridCols": number,    // integer number of columns you see (1-40)
  "notes": string,       // one short sentence describing the space
  "confidence": number   // 0..1
}`;

const IDENTIFY_PROMPT = `Identify the single main tool or item in this photo for a garage inventory.
Read any visible brand/model text. Respond with STRICT JSON ONLY, no prose:
{
  "name": string,        // short human-readable item name
  "category": string,    // one of ${JSON.stringify(CATEGORIES)}
  "brand": string,       // "" if unknown
  "model": string,       // "" if unknown
  "text": string,        // any readable text on the item, or ""
  "confidence": number   // 0..1
}`;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 25 * 1024 * 1024) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { ...cors, "Content-Type": "application/json" });
  res.end(body);
}

const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    res.end();
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    send(res, 200, { ok: true, model: MODEL });
    return;
  }

  try {
    if (req.method === "POST" && req.url === "/map-space") {
      const { imageDataUrl, hint } = parseJson(await readBody(req));
      if (!imageDataUrl) return send(res, 400, { error: "missing imageDataUrl" });
      const out = await askModel(MAP_PROMPT(hint), toBase64(imageDataUrl));
      return send(res, 200, {
        type: LOCATION_TYPES.includes(String(out.type)) ? out.type : "space",
        gridRows: clampInt(out.gridRows, 1, 40, 4),
        gridCols: clampInt(out.gridCols, 1, 40, 4),
        notes: typeof out.notes === "string" ? out.notes : "",
        confidence: clamp01(out.confidence ?? 0.6),
      });
    }

    if (req.method === "POST" && req.url === "/identify-item") {
      const { imageDataUrl } = parseJson(await readBody(req));
      if (!imageDataUrl) return send(res, 400, { error: "missing imageDataUrl" });
      const out = await askModel(IDENTIFY_PROMPT, toBase64(imageDataUrl));
      const cat = String(out.category || "").toLowerCase();
      return send(res, 200, {
        name: typeof out.name === "string" ? out.name : "Unknown item",
        category: CATEGORIES.includes(cat) ? cat : "other",
        brand: typeof out.brand === "string" ? out.brand : "",
        model: typeof out.model === "string" ? out.model : "",
        text: typeof out.text === "string" ? out.text : "",
        confidence: clamp01(out.confidence ?? 0.6),
      });
    }

    send(res, 404, { error: "not found" });
  } catch (e) {
    console.error("[vision] error:", e?.message || e);
    send(res, 500, { error: String(e?.message || e) });
  }
});

server.listen(PORT, () => {
  console.log(`[vision] adapter listening on :${PORT} -> Ollama ${OLLAMA_URL} model ${MODEL}`);
});
