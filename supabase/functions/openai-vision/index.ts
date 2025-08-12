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

    const { imageDataUrl, mode } = await req.json();
    if (!imageDataUrl || !mode) {
      return new Response(JSON.stringify({ error: "Missing imageDataUrl or mode" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Build request to OpenAI GPT-4o-mini with vision
    const systemPrompt =
      "You are a precise vision assistant. Always respond with strict JSON only, no prose.";

    const baseUserInstructionIdentify = `
You will be given an image. Identify the main item with a short, precise, human-readable name (include brand/model if visible). Estimate a confidence 0..1.
Provide up to 8 general labels, up to 5 web-like entities (keywords), up to 3 object names (no boxes), and extract all readable text.
Assign exactly ONE category from this allowed set (lowercase):
["hand tools","power tools","electrical","plumbing","cutting tools","measuring tools","other"]
Also decide the best placementType for a workshop with this storage layout:
- 20 small bins for small parts (fasteners, connectors) => "bin"
- 100 pegboard hooks/slots for hand/measuring/cutting tools => "pegboard"
- A small 5-drawer sockets cabinet (for sockets/ratchets/torx) => "sockets-drawer"
- A large 4x8 drawer for bulkier power tools => "drawer"
- A floor/rack area for large/heavy items => "large-area"
- A general shelf area for everything else => "general-shelf"
Return strict JSON only with this schema:
{
  "specificName": string,
  "confidence": number,
  "bestGuess": string,
  "category": string,              // one of the allowed set above, lowercase
  "placementType": string,         // one of: ["bin","pegboard","drawer","sockets-drawer","large-area","general-shelf"]
  "webEntities": [ { "description": string, "score": number } ],
  "labels": [ { "description": string, "score": number } ],
  "objects": [ { "name": string, "score": number } ],
  "text": string
}
Keep arrays concise. No extra fields.`;

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
        body: JSON.stringify(bodyCommon(baseUserInstructionIdentify)),
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

      return new Response(
        JSON.stringify({ specificName, confidence, labels, objects, webEntities, text, bestGuess, category, placementType }),
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
