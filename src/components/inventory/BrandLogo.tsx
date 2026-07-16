import { useEffect, useState } from "react";
import { resolveBrandDomain, logoImageUrl } from "@/lib/brandLogo";
import { cn } from "@/lib/utils";

/** A brand's logo (via logos.dev), or nothing if the brand can't be resolved / has no logo. Renders
 *  null so callers can place it inline without reserving space when there's no logo. */
export function BrandLogo({ brand, size = 28, className }: { brand?: string | null; size?: number; className?: string }) {
  const [domain, setDomain] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let ok = true;
    setFailed(false);
    setDomain(null);
    const b = (brand || "").trim();
    if (b) resolveBrandDomain(b).then((d) => { if (ok) setDomain(d); });
    return () => { ok = false; };
  }, [brand]);

  const url = domain ? logoImageUrl(domain, size * 2) : null;
  if (!url || failed) return null;
  return (
    <img
      src={url}
      alt={brand || ""}
      onError={() => setFailed(true)}
      loading="lazy"
      className={cn("shrink-0 rounded object-contain bg-white ring-1 ring-black/5", className)}
      style={{ width: size, height: size }}
    />
  );
}
