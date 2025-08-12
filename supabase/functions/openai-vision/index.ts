import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function clamp01(n: number) {
  if (Number.isNaN(Number(n))) return 0;
  return Math.max(0, Math.min(1, Number(n)));
}

function safeJsonParse(input: string): any {
  try {
    return JSON.parse(input);
  } catch (_) {
    const start = input.indexOf("{");
    const end = input.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      try {
        return JSON.parse(input.slice(start, end + 1));
      } catch (_) {}
    }
    return {};
  }
}

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const apiKey = Deno.env.get("OPENAI_API_KEY");
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "Missing OPENAI_API_KEY" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { imageDataUrl, mode, dimsInches } = await req.json();
    if (!imageDataUrl || !mode) {
      return new Response(JSON.stringify({ error: "Missing imageDataUrl or mode" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const dims = dimsInches && typeof dimsInches === 'object' ? {
      length: Number(dimsInches.length ?? NaN),
      width: Number(dimsInches.width ?? NaN),
      height: Number(dimsInches.height ?? NaN),
    } : null;

    // Build request to OpenAI GPT-4o-mini with vision
    const systemPrompt =
      "You are a precise vision assistant. Always respond with strict JSON only, no prose.";

    const identifyInstruction = `
You will be given an image. Identify the main item with a short, precise, human-readable name (include brand/model if visible). Estimate a confidence 0..1.
Provide up to 8 general labels, up to 5 web-like entities (keywords), up to 3 object names (no boxes), and extract all readable text.
Assign exactly ONE category from this allowed set (lowercase):
["hand tools","power tools","electrical","plumbing","cutting tools","measuring tools","other"]

Storage layout and sizing (IMPORTANT):
- 20 small bins for small parts (fasteners, connectors) => "bin"
- 100 pegboard hooks/slots for hand/measuring/cutting tools => "pegboard"
- A small 5-drawer sockets cabinet (for sockets/ratchets/torx) => "sockets-drawer"
- A large 4x8 drawer for bulkier power tools => "drawer"
- A floor/rack area for large/heavy items => "large-area"
- A general shelf area for everything else => "general-shelf"

26-gallon bin internal size approx 23.5 x 18 x 16.5 inches (volume ≈ 6000 in^3). An item is "bin-eligible" only if its approximate L/W/H all fit within those internal dimensions AND its rough volume is ≤ 6000 in^3.
${(dims && Number.isFinite(dims.length) && Number.isFinite(dims.width) && Number.isFinite(dims.height))
  ? `User-provided approximate dimensions (inches): L=${dims.length}, W=${dims.width}, H=${dims.height}. Use these to decide if "bin" is appropriate.`
  : `No dimensions provided. If dimensions are needed to decide between "bin" vs other placements, set "needsDimensions": true and include a short "dimensionQuestion" asking for approximate L, W, H in inches (e.g., "About how long, wide, and tall is it?").`}

Return strict JSON ONLY with this schema:
{
  "specificName": string,
  "confidence": number,
  "bestGuess": string,
  "category": string,              // one of the allowed set above, lowercase
  "placementType": string,         // one of: ["bin","pegboard","drawer","sockets-drawer","large-area","general-shelf"]
  "webEntities": [ { "description": string, "score": number } ],
  "labels": [ { "description": string, "score": number } ],
  "objects": [ { "name": string, "score": number } ],
  "text": string,
  "needsDimensions": boolean,      // true only if you need L/W/H to decide placement
  "dimensionQuestion": string      // present only if needsDimensions is true
}
Keep arrays concise. No extra fields.`

    const baseUserInstructionLabels = `
You will be given an image. Provide up to 10 general labels with confidence scores 0..1 as strict JSON only:
{ "labels": [ { "description": string, "score": number } ] }`;

    const baseUserInstructionOCR = `
You will be given an image. Extract all readable text and return strict JSON only:
{ "text": string }`;

    const bodyCommon = (instruction: string) => ({
      model: "gpt-4o-mini",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            { type: "text", text: instruction },
            { type: "image_url", image_url: { url: String(imageDataUrl) } },
          ],
        },
      ],
    });

    let openAIResponse: Response;

    if (mode === "identify") {
      openAIResponse = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(bodyCommon(identifyInstruction)),
      });
    } else if (mode === "labels") {
      openAIResponse = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(bodyCommon(baseUserInstructionLabels)),
      });
    } else {
      // ocr
      openAIResponse = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(bodyCommon(baseUserInstructionOCR)),
      });
    }

    const openAIData = await openAIResponse.json();
    if (!openAIResponse.ok) {
      console.error("OpenAI API error:", openAIData);
      return new Response(
        JSON.stringify({ error: openAIData.error?.message || "OpenAI API error" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const content: string = openAIData?.choices?.[0]?.message?.content?.trim?.() ?? "{}";
    const parsed = safeJsonParse(content);

    if (mode === "identify") {
      const specificName: string = String(parsed.specificName || parsed.bestGuess || "Unknown item");
      const bestGuess: string = String(parsed.bestGuess || specificName);
      const confidence: number = clamp01(parsed.confidence ?? 0.7);
      const labels = Array.isArray(parsed.labels)
        ? parsed.labels.map((l: any) => ({ description: String(l.description || ""), score: clamp01(l.score) }))
        : [];
      const objects = Array.isArray(parsed.objects)
        ? parsed.objects.map((o: any) => ({ name: String(o.name || ""), score: clamp01(o.score) }))
        : [];
      const webEntities = Array.isArray(parsed.webEntities)
        ? parsed.webEntities.map((w: any) => ({ description: String(w.description || ""), score: clamp01(w.score) }))
        : [];
      const text: string = typeof parsed.text === "string" ? parsed.text : "";
      const rawCategory = typeof parsed.category === "string" ? parsed.category.toLowerCase().trim() : "";
      const allowed = new Set(["hand tools","power tools","electrical","plumbing","cutting tools","measuring tools","other"]);
      const category = allowed.has(rawCategory) ? rawCategory : "";
      const placementType: string = typeof parsed.placementType === 'string' ? parsed.placementType : '';

      const needsDimensions: boolean = !!parsed.needsDimensions;
      const dimensionQuestion: string = typeof parsed.dimensionQuestion === 'string' ? parsed.dimensionQuestion : '';

      return new Response(
        JSON.stringify({ specificName, confidence, labels, objects, webEntities, text, bestGuess, category, placementType, needsDimensions, dimensionQuestion }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    } else if (mode === "labels") {
      const labels = Array.isArray(parsed.labels)
        ? parsed.labels.map((l: any) => ({ description: String(l.description || ""), score: clamp01(l.score) }))
        : [];
      return new Response(
        JSON.stringify({ labels }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    } else {
      const text: string = typeof parsed.text === "string" ? parsed.text : "";
      return new Response(
        JSON.stringify({ text }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
  } catch (e) {
    console.error("openai-vision function error:", e);
    return new Response(
      JSON.stringify({ error: e?.message || "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
