// Find Mode — hands-free "where's my …?". Ask out loud and the assistant tells you which bin a tool
// lives in and speaks it back, highlighting the match. Voice is transcribed on the connector's local
// whisper.cpp (like Rapid Mode); a text box is the fallback when the connector isn't reachable
// (e.g. the hosted site can't reach localhost). Reuses speech.ts + whisperStt.ts.

import { useEffect, useRef, useState } from "react";
import { Mic, Search, X, Loader2, MapPin, Volume2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { speak, stopSpeaking } from "@/lib/speech";
import { listen } from "@/lib/whisperStt";
import { haptic } from "@/lib/haptics";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

interface Hit {
  id: string;
  name: string;
  category: string | null;
  qr_code: string | null;
  bin: string | null;
  shelf: string | null;
  quantity: number;
}

const FILLER = /\b(where'?s?|is|are|the|my|a|an|find|me|located|do i have|any|show|look for|got)\b/g;

/** Look up items whose name (or category) matches the spoken/typed query, with their bin + shelf. */
async function search(raw: string): Promise<Hit[]> {
  const q = raw.toLowerCase().replace(FILLER, " ").replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
  if (!q) return [];
  const tokens = q.split(" ").filter((t) => t.length > 2);
  const needles = tokens.length ? tokens : [q];
  // OR across tokens on name and category, then rank by how many tokens hit the name.
  const ors = needles.flatMap((t) => [`name.ilike.%${t}%`, `category.ilike.%${t}%`]).join(",");
  const { data: items } = await supabase
    .from("items").select("id,name,category,qr_code").or(ors).limit(25);
  if (!items?.length) return [];
  const ranked = items
    .map((it) => {
      const nl = (it.name || "").toLowerCase();
      const score = needles.reduce((s, t) => s + (nl.includes(t) ? 2 : 0) + ((it.category || "").toLowerCase().includes(t) ? 1 : 0), 0);
      return { it, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  // Resolve each match's bin + shelf.
  const hits: Hit[] = [];
  for (const { it } of ranked) {
    const { data: loc } = await supabase
      .from("item_locations").select("location_id,quantity").eq("item_id", it.id).limit(1).maybeSingle();
    let bin: string | null = null, shelf: string | null = null;
    if (loc?.location_id) {
      const { data: l } = await supabase
        .from("locations").select("name,parent_location_id").eq("id", loc.location_id).maybeSingle();
      bin = l?.name ?? null;
      if (l?.parent_location_id) {
        const { data: p } = await supabase.from("locations").select("name").eq("id", l.parent_location_id).maybeSingle();
        shelf = p?.name ?? null;
      }
    }
    hits.push({ id: it.id, name: it.name, category: it.category, qr_code: it.qr_code, bin, shelf, quantity: loc?.quantity || 1 });
  }
  return hits;
}

function spokenAnswer(query: string, hits: Hit[]): string {
  if (!hits.length) return `I couldn't find anything matching ${query}.`;
  const top = hits[0];
  const where = top.bin
    ? `${top.bin}${top.category ? `, in ${top.category}` : ""}${top.shelf ? `, on ${top.shelf}` : ""}`
    : "the inventory, but it isn't filed in a bin yet";
  const more = hits.length > 1 ? ` I found ${hits.length - 1} other match${hits.length - 1 === 1 ? "" : "es"} too.` : "";
  return `${top.name} is in ${where}.${more}`;
}

export function FindMode({ open, onOpenChange }: Props) {
  const streamRef = useRef<MediaStream | null>(null);
  const aliveRef = useRef(false);
  const [phase, setPhase] = useState<"listening" | "thinking" | "answering" | "idle" | "novoice">("idle");
  const [caption, setCaption] = useState("");
  const [heard, setHeard] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [typed, setTyped] = useState("");

  const say = async (t: string) => { setCaption(t); await speak(t); };

  const runQuery = async (query: string) => {
    setHeard(query);
    setPhase("thinking");
    const found = await search(query);
    setHits(found);
    haptic.light();
    setPhase("answering");
    await say(spokenAnswer(query, found));
  };

  // Voice session: greet, then loop listen → answer → "anything else?" until "done".
  useEffect(() => {
    if (!open) return;
    aliveRef.current = true;
    setHits([]); setHeard(""); setCaption(""); setTyped("");

    const voiceLoop = async () => {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      } catch {
        setPhase("novoice");
        setCaption("Type what you're looking for.");
        return;
      }
      streamRef.current = stream;
      await say("What are you looking for?");
      while (aliveRef.current) {
        setPhase("listening");
        let query = "";
        try {
          query = await listen(stream, 3600);
        } catch {
          setPhase("novoice");
          setCaption("Voice search needs the printer connector running. Type instead.");
          return;
        }
        if (!aliveRef.current) return;
        if (!query) { await say("I didn't catch that. What are you looking for?"); continue; }
        if (/\b(done|finish|close|stop|exit|nothing|that'?s all|quit)\b/.test(query)) break;
        await runQuery(query);
        if (!aliveRef.current) return;
        setPhase("listening");
        await say("Anything else?");
      }
      onOpenChange(false);
    };
    voiceLoop();

    return () => {
      aliveRef.current = false;
      stopSpeaking();
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const submitTyped = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!typed.trim()) return;
    await runQuery(typed.trim());
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100] bg-tile text-tile-foreground flex flex-col">
      <div className="flex items-center justify-between p-4 border-b border-tile-edge">
        <div className="flex items-center gap-2 font-display text-lg">
          <Search className="h-5 w-5 text-primary" /> Find a tool
        </div>
        <Button size="icon" variant="ghost" className="text-tile-foreground hover:bg-white/10" onClick={() => onOpenChange(false)} aria-label="Close">
          <X className="h-6 w-6" />
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-5 space-y-4">
        <div className="flex flex-col items-center gap-3 text-center py-4">
          {phase === "listening" && <Mic className="h-12 w-12 text-primary animate-pulse" />}
          {phase === "thinking" && <Loader2 className="h-10 w-10 animate-spin text-primary" />}
          {(phase === "answering" || phase === "idle" || phase === "novoice") && <Search className="h-10 w-10 text-primary" />}
          {caption && (
            <p className="flex items-center justify-center gap-2 text-base max-w-md">
              <Volume2 className="h-4 w-4 shrink-0 text-primary" /> {caption}
            </p>
          )}
          {heard && <p className="text-sm text-tile-foreground/60">“{heard}”</p>}
        </div>

        {hits.length > 0 && (
          <ul className="space-y-2 max-w-lg mx-auto">
            {hits.map((h, i) => (
              <li key={h.id} className={`rounded-lg border p-3 ${i === 0 ? "border-primary bg-primary/10" : "border-tile-edge"}`}>
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-semibold truncate">{h.name}{h.quantity > 1 ? ` ×${h.quantity}` : ""}</div>
                    {h.category && <div className="text-xs text-tile-foreground/60">{h.category}</div>}
                  </div>
                  <div className="text-right shrink-0">
                    {h.bin ? (
                      <div className="flex items-center gap-1 font-display font-bold">
                        <MapPin className="h-4 w-4 text-primary" /> {h.bin}
                      </div>
                    ) : (
                      <span className="text-xs text-tile-foreground/50">not filed</span>
                    )}
                    {h.shelf && <div className="text-[11px] text-tile-foreground/50">{h.shelf}</div>}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Text fallback — always available, and the only path when voice/connector isn't reachable. */}
      <form onSubmit={submitTyped} className="p-4 border-t border-tile-edge flex gap-2 max-w-lg mx-auto w-full">
        <Input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder="Type a tool name…"
          className="bg-background text-foreground"
        />
        <Button type="submit"><Search className="h-4 w-4" /></Button>
      </form>
    </div>
  );
}
