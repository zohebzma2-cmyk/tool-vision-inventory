// In-app assistant. A chat that can look things up AND act on your inventory (writes are confirmed),
// with photo input and tappable multiple-choice. The model runs on the Worker's /chat proxy; the
// tool-calling loop runs here so tools hit Supabase as the signed-in user, and every change waits for
// your approval before it happens.

import { useEffect, useRef, useState } from "react";
import { Bot, X, Send, Camera, Loader2, Check, Wrench, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { callAgent, isAgentConfigured, type LlmMessage } from "@/lib/agentChat";
import { AGENT_SYSTEM_PROMPT, executeTool } from "@/lib/agentTools";

type Bubble =
  | { kind: "user"; text: string; image?: string | null }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; text: string };

type Pending =
  | { type: "confirm"; summary: string }
  | { type: "choice"; question: string; options: string[] };

const TOOL_LABEL: Record<string, string> = {
  search_items: "Searching items…",
  locate_item: "Locating…",
  list_bins: "Reading the bins…",
  bin_contents: "Opening the bin…",
  create_item: "Preparing to create…",
  move_item: "Preparing to move…",
  set_bin_category: "Preparing to relabel…",
};

async function fileToDataUrl(file: File): Promise<string> {
  const raw = await new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = rej;
    r.readAsDataURL(file);
  });
  // Downscale so requests stay small.
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = raw; });
    const maxW = 1024, scale = Math.min(1, maxW / Math.max(img.width, img.height));
    const c = document.createElement("canvas");
    c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
    c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.75);
  } catch {
    return raw;
  }
}

export function AgentChat({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [input, setInput] = useState("");
  const [image, setImage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const llmRef = useRef<LlmMessage[]>([{ role: "system", content: AGENT_SYSTEM_PROMPT }]);
  const resolveRef = useRef<((v: unknown) => void) | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const add = (b: Bubble) => setBubbles((p) => [...p, b]);
  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" }); }, [bubbles, pending]);

  const waitUser = <T,>(p: Pending): Promise<T> =>
    new Promise((res) => { resolveRef.current = res as (v: unknown) => void; setPending(p); });
  const answer = (v: unknown) => { const r = resolveRef.current; resolveRef.current = null; setPending(null); r?.(v); };

  // Wipe the conversation back to a clean state — the guaranteed escape hatch if anything ever hangs
  // or a bad tool round-trip wedges the history.
  const reset = () => {
    resolveRef.current = null;
    llmRef.current = [{ role: "system", content: AGENT_SYSTEM_PROMPT }];
    setPending(null); setBusy(false); setBubbles([]);
  };

  const runLoop = async () => {
    setBusy(true);
    try {
      for (let hop = 0; hop < 6; hop++) {
        const msg = await callAgent(llmRef.current);
        llmRef.current.push(msg);
        const calls = msg.tool_calls || [];
        if (!calls.length) { add({ kind: "assistant", text: String(msg.content || "…") }); break; }
        if (msg.content) add({ kind: "assistant", text: String(msg.content) });
        let awaitText = false; // set when we need a typed reply — end the loop so the user can type
        for (const tc of calls) {
          // CRITICAL: every tool_call MUST get a matching tool response pushed below, even on failure.
          // A dangling tool_call makes the model API reject every future message (the chat would brick
          // until reload). So all paths set `content`, and the push happens unconditionally at the end.
          let content: string;
          try {
            let args: Record<string, unknown> = {};
            try { args = JSON.parse(tc.function.arguments || "{}"); } catch { /* keep {} */ }
            if (tc.function.name === "ask_user_choice") {
              const opts = Array.from(new Set(((args.options as string[]) || []).map((o) => String(o).trim()).filter(Boolean)));
              add({ kind: "assistant", text: String(args.question || "Which one?") });
              if (opts.length >= 1) {
                const choice = await waitUser<string>({ type: "choice", question: String(args.question || ""), options: opts });
                add({ kind: "user", text: choice });
                content = JSON.stringify({ chosen: choice });
              } else {
                // No usable options → can't render buttons. Don't hang: answer the call and end the
                // loop so the user can type their reply as a normal message.
                content = JSON.stringify({ chosen: null, note: "No options were provided; ask the user to type their answer." });
                awaitText = true;
              }
            } else {
              add({ kind: "tool", text: TOOL_LABEL[tc.function.name] || tc.function.name });
              const tr = await executeTool(tc.function.name, args);
              if (tr.confirm) {
                const ok = await waitUser<boolean>({ type: "confirm", summary: tr.confirm.summary });
                if (ok) { const r = await tr.confirm.run(); add({ kind: "tool", text: `✓ ${tr.confirm.summary}` }); content = JSON.stringify({ confirmed: true, result: r }); }
                else { add({ kind: "tool", text: "✗ Declined" }); content = JSON.stringify({ declined: true }); }
              } else {
                content = JSON.stringify(tr.result);
              }
            }
          } catch (err) {
            // A tool (or its confirmed run) threw. Surface it AND still answer the tool_call so the
            // conversation stays valid for the next message.
            add({ kind: "tool", text: `⚠ ${tc.function.name} failed` });
            content = JSON.stringify({ error: String((err as Error)?.message || err) });
          }
          llmRef.current.push({ role: "tool", tool_call_id: tc.id, content: content.slice(0, 4000) });
        }
        if (awaitText) break; // let the user type their answer; the next send continues the conversation
      }
    } catch (e) {
      add({ kind: "assistant", text: `⚠ ${String((e as Error)?.message || e)}` });
    } finally {
      setBusy(false);
    }
  };

  const send = () => {
    const text = input.trim();
    if ((!text && !image) || busy) return;
    const content = image ? [{ type: "text", text: text || "What is this, and can you file it?" }, { type: "image_url", image_url: { url: image } }] : text;
    llmRef.current.push({ role: "user", content });
    add({ kind: "user", text: text || "(photo)", image });
    setInput(""); setImage(null);
    void runLoop();
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      <div className="flex items-center justify-between border-b p-3">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-primary-foreground"><Bot className="h-4 w-4" /></span>
          <div><div className="font-display font-semibold leading-tight">Assistant</div><div className="text-xs text-muted-foreground">Ask, or send a photo — it can act with your OK</div></div>
        </div>
        <div className="flex items-center gap-1">
          {bubbles.length > 0 && (
            <button onClick={reset} className="rounded p-1.5 text-muted-foreground hover:bg-muted" aria-label="Reset conversation" title="Start over"><RotateCcw className="h-4 w-4" /></button>
          )}
          <button onClick={() => onOpenChange(false)} className="rounded p-1.5 hover:bg-muted" aria-label="Close"><X className="h-5 w-5" /></button>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-3">
        {!isAgentConfigured() && (
          <p className="rounded-md bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400">
            The assistant needs the vision service (VITE_VISION_API_URL) and the Worker’s /chat endpoint deployed.
          </p>
        )}
        {bubbles.length === 0 && (
          <div className="pt-8 text-center text-sm text-muted-foreground">
            Try: “Where’s my 6-inch backing pad?” · “What’s in Bin 4?” · “How many M14 adapters do I have?” · or send a photo of a tool.
          </div>
        )}
        {bubbles.map((b, i) => (
          <div key={i} className={b.kind === "user" ? "flex justify-end" : "flex justify-start"}>
            {b.kind === "tool" ? (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground"><Wrench className="h-3 w-3" />{b.text}</div>
            ) : (
              <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${b.kind === "user" ? "bg-primary text-primary-foreground" : "bg-muted"}`}>
                {"image" in b && b.image && <img src={b.image} alt="" className="mb-1 max-h-40 rounded-lg" />}
                <span className="whitespace-pre-wrap">{b.text}</span>
              </div>
            )}
          </div>
        ))}
        {busy && !pending && <div className="flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> Thinking…</div>}

        {/* confirm card for write actions */}
        {pending?.type === "confirm" && (
          <div className="rounded-lg border bg-card p-3">
            <p className="mb-2 text-sm font-medium">{pending.summary}?</p>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => answer(true)}><Check className="mr-1 h-4 w-4" /> Do it</Button>
              <Button size="sm" variant="secondary" onClick={() => answer(false)}>No</Button>
            </div>
          </div>
        )}
        {/* multiple-choice card */}
        {pending?.type === "choice" && (
          <div className="rounded-lg border bg-card p-3">
            <p className="mb-2 text-sm font-medium">{pending.question}</p>
            <div className="flex flex-wrap gap-2">
              {pending.options.map((o) => (
                <Button key={o} size="sm" variant="secondary" onClick={() => answer(o)}>{o}</Button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="flex items-end gap-2 border-t p-3">
        <input ref={fileRef} type="file" accept="image/*" capture="environment" className="hidden"
          onChange={async (e) => { const f = e.target.files?.[0]; if (f) setImage(await fileToDataUrl(f)); e.currentTarget.value = ""; }} />
        <button onClick={() => fileRef.current?.click()} disabled={busy} className="rounded-full p-2 text-muted-foreground hover:bg-muted disabled:opacity-50" aria-label="Add photo"><Camera className="h-5 w-5" /></button>
        <div className="flex-1">
          {image && <img src={image} alt="" className="mb-1 h-12 rounded" />}
          <textarea value={input} onChange={(e) => setInput(e.target.value)} rows={1} placeholder="Ask or tell the assistant…"
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
            className="w-full resize-none rounded-2xl border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary" />
        </div>
        <Button size="sm" className="h-9 w-9 rounded-full p-0" onClick={send} disabled={busy || (!input.trim() && !image)}><Send className="h-4 w-4" /></Button>
      </div>
    </div>
  );
}
