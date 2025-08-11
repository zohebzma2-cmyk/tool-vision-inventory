import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const apiKey = Deno.env.get("GOOGLE_CLOUD_VISION_API_KEY");
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "Missing GOOGLE_CLOUD_VISION_API_KEY" }), {
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

    // Convert input to base64 content supported by Vision API
    let base64Content = "";
    if (typeof imageDataUrl === "string" && imageDataUrl.startsWith("data:")) {
      const splitIdx = imageDataUrl.indexOf("base64,");
      base64Content = splitIdx !== -1 ? imageDataUrl.substring(splitIdx + 7) : "";
    } else if (
      typeof imageDataUrl === "string" &&
      (imageDataUrl.startsWith("http://") || imageDataUrl.startsWith("https://"))
    ) {
      const imgResp = await fetch(imageDataUrl);
      const buf = await imgResp.arrayBuffer();
      base64Content = btoa(String.fromCharCode(...new Uint8Array(buf)));
    } else {
      return new Response(JSON.stringify({ error: "Unsupported image format" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Choose Vision features
    let features: Array<Record<string, unknown>>;
    if (mode === "labels") {
      features = [{ type: "LABEL_DETECTION", maxResults: 10 }];
    } else if (mode === "identify") {
      features = [
        { type: "LABEL_DETECTION", maxResults: 10 },
        { type: "WEB_DETECTION" },
        { type: "OBJECT_LOCALIZATION" },
        { type: "TEXT_DETECTION" },
      ];
    } else {
      features = [{ type: "TEXT_DETECTION" }];
    }

    const payload = {
      requests: [
        {
          image: { content: base64Content },
          features,
        },
      ],
    };

    const visionRes = await fetch(
      `https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }
    );

    const visionData = await visionRes.json();
    if (!visionRes.ok) {
      console.error("Vision API error:", visionData);
      return new Response(
        JSON.stringify({ error: visionData.error?.message || "Vision API error" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const resp = visionData.responses?.[0] ?? {};

    if (mode === "identify") {
      const web = resp.webDetection ?? {};
      const bestGuess = (web.bestGuessLabels?.[0]?.label || "").trim();
      const webEntitiesRaw = Array.isArray(web.webEntities) ? web.webEntities : [];
      const webEntities = webEntitiesRaw
        .filter((w: any) => w?.description)
        .map((w: any) => ({ description: String(w.description), score: Number(w.score || 0), entityId: w.entityId }))
        .sort((a: any, b: any) => (b.score || 0) - (a.score || 0));

      const labels = (resp.labelAnnotations ?? []).map((l: any) => ({ description: l.description, score: l.score }));
      const objects = (resp.localizedObjectAnnotations ?? []).map((o: any) => ({ name: o.name, score: o.score }));
      const text = resp.fullTextAnnotation?.text || "";

      // Build ranked candidates, preferring Lens-like best guess, then strong web entities, then objects/labels
      const candidates: Array<{ name: string; score: number; source: string }> = [];
      if (bestGuess) candidates.push({ name: bestGuess, score: (webEntities[0]?.score ?? 0.7) + 0.05, source: 'bestGuess' });
      if (webEntities[0]?.description) candidates.push({ name: webEntities[0].description, score: webEntities[0].score, source: 'webEntity' });
      if (objects[0]?.name) candidates.push({ name: objects[0].name, score: objects[0].score || 0, source: 'object' });
      if (labels[0]?.description) candidates.push({ name: labels[0].description, score: labels[0].score || 0, source: 'label' });

      // Deduplicate by lowercase name
      const seen = new Set<string>();
      const unique = candidates.filter(c => {
        const key = c.name.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      const top = unique.sort((a, b) => b.score - a.score)[0] || { name: 'Unknown item', score: 0 };
      const specificName = top.name;
      const confidence = Math.max(0, Math.min(1, Number(top.score || 0)));

      return new Response(
        JSON.stringify({ specificName, confidence, webEntities, labels, objects, text, bestGuess }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    } else if (mode === "labels") {
      const labels = resp.labelAnnotations ?? [];
      return new Response(
        JSON.stringify({ labels: labels.map((l: any) => ({ description: l.description, score: l.score })) }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    } else {
      const text =
        resp.fullTextAnnotation?.text ||
        (Array.isArray(resp.textAnnotations)
          ? resp.textAnnotations.map((t: any) => t.description).join("\n")
          : "");
      return new Response(JSON.stringify({ text }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  } catch (e) {
    console.error("google-vision function error:", e);
    return new Response(
      JSON.stringify({ error: e?.message || "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
