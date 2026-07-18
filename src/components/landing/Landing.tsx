// The logged-out web experience — a real product landing, not a bare login. Machinist identity:
// graphite base, engraved condensed caps, mono codes, one hi-vis accent, and a signature bin-wall
// grid built in CSS (the actual product, shown as the hero). "Get started" reveals the sign-in.

import { useState } from "react";
import { Wrench, ScanLine, Printer, Bot, ArrowRight, Camera, Boxes, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AuthScreen } from "@/components/auth/AuthScreen";

const FEATURES = [
  { icon: Camera, title: "Identify at a glance", body: "Point your camera at a bin or a tool. It names the item, reads the brand and size, and files it with a photo — no typing." },
  { icon: Printer, title: "Label the whole wall", body: "Print QR bin labels and tool tags on a Brother label printer. Scan any code to jump straight to what's inside." },
  { icon: Bot, title: "Ask where anything is", body: "Search, scan, or just ask the assistant — “where's my 6-inch backing pad?” — and it answers across every bin." },
];

const STEPS = [
  { n: "01", title: "Map your space", body: "Snap your bin wall or pegboard; it becomes labeled slots." },
  { n: "02", title: "Scan a bin", body: "Camera in, AI out — every tool filed with a photo and a code." },
  { n: "03", title: "Print labels", body: "QR bin labels + tool tags roll out of the label printer." },
  { n: "04", title: "Find anything", body: "By search, by scan, or by asking. Seconds, not digging." },
];

// A stylized 6-column bin wall — the product, as the hero visual.
function BinWall() {
  const filled = new Set([1, 4, 7, 10, 13, 16, 19, 22]);
  const codes = ["RQ3ML", "AFXJS", "C8L9M", "Z989W", "42XPT", "ND2XE", "5GMGF", "JYEJD"];
  let ci = 0;
  return (
    <div className="grid grid-cols-6 gap-1.5 rounded border border-border bg-tile/40 p-2 shadow-soft">
      {Array.from({ length: 24 }).map((_, i) => {
        const on = filled.has(i);
        const code = on ? codes[ci++ % codes.length] : "";
        return (
          <div key={i} className={`relative aspect-square rounded-sm border ${on ? "border-primary/70 bg-card" : "border-border bg-background/60"}`}>
            {on && (
              <>
                <span className="absolute left-1 top-1 h-1.5 w-1.5 rounded-full bg-primary" />
                <span className="absolute inset-x-1 bottom-1 truncate font-mono text-[7px] leading-none text-muted-foreground">{code}</span>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function Landing() {
  const [showAuth, setShowAuth] = useState(false);
  if (showAuth) return <AuthScreen />;

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* control bar */}
      <header className="sticky top-0 z-20 border-b border-border bg-background/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="label-tile flex h-8 w-8 items-center justify-center border border-tile-edge"><Wrench className="h-4 w-4" /></span>
            <span className="font-display text-xl font-bold uppercase tracking-wide">Tool Vision</span>
          </div>
          <Button size="sm" onClick={() => setShowAuth(true)}>Sign in</Button>
        </div>
      </header>

      {/* hero */}
      <section className="mx-auto grid max-w-6xl items-center gap-10 px-4 py-14 md:grid-cols-2 md:py-20">
        <div>
          <p className="mb-4 inline-flex items-center gap-2 rounded-sm border border-border bg-card px-2.5 py-1 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
            <span className="h-1.5 w-1.5 rounded-full bg-primary" /> Garage inventory, labeled
          </p>
          <h1 className="font-display text-5xl font-bold uppercase leading-[0.95] tracking-tight md:text-7xl">
            Know where<br /><span className="text-primary">every tool</span> is.
          </h1>
          <p className="mt-5 max-w-md text-base text-muted-foreground md:text-lg">
            Point your camera at a bin. Tool Vision identifies what's inside, files it with a photo, and prints a QR label — so you find any tool in seconds, not by digging.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <Button size="lg" onClick={() => setShowAuth(true)}>Get started <ArrowRight className="ml-1.5 h-4 w-4" /></Button>
            <a href="#how" className="inline-flex items-center rounded-sm border border-border px-4 py-2 text-sm font-medium hover:bg-accent">See how it works</a>
          </div>
        </div>
        <div className="relative">
          <BinWall />
          <div className="mt-3 flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
            <ScanLine className="h-3.5 w-3.5 text-primary" /> 36-bin wall · every slot scannable
          </div>
        </div>
      </section>

      {/* features */}
      <section className="border-y border-border bg-card/40">
        <div className="mx-auto grid max-w-6xl gap-px overflow-hidden rounded border border-border bg-border md:grid-cols-3">
          {FEATURES.map((f) => (
            <div key={f.title} className="bg-card p-6">
              <f.icon className="h-6 w-6 text-primary" />
              <h3 className="mt-4 font-display text-lg font-semibold uppercase tracking-wide">{f.title}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* how it works — a real sequence, so numbering earns its place */}
      <section id="how" className="mx-auto max-w-6xl px-4 py-16">
        <h2 className="font-display text-3xl font-bold uppercase tracking-tight md:text-4xl">Four steps to a labeled shop</h2>
        <div className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((s) => (
            <div key={s.n} className="border-t-2 border-primary pt-4">
              <div className="font-mono text-2xl text-primary">{s.n}</div>
              <h3 className="mt-2 font-display text-lg font-semibold uppercase tracking-wide">{s.title}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{s.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="border-t border-border bg-tile/50">
        <div className="mx-auto flex max-w-6xl flex-col items-center gap-5 px-4 py-16 text-center">
          <Boxes className="h-8 w-8 text-primary" />
          <h2 className="font-display text-3xl font-bold uppercase tracking-tight md:text-4xl">Stop losing tools in the pile.</h2>
          <p className="max-w-md text-muted-foreground">Set up your first bin wall in minutes. Free to start.</p>
          <Button size="lg" onClick={() => setShowAuth(true)}>Get started <ArrowRight className="ml-1.5 h-4 w-4" /></Button>
        </div>
      </section>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-6 font-mono text-xs text-muted-foreground">
          <span>TOOL VISION</span>
          <span className="flex items-center gap-1.5"><Search className="h-3.5 w-3.5" /> every tool, findable</span>
        </div>
      </footer>
    </div>
  );
}
