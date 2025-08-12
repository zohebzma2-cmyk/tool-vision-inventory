import { useEffect, useState } from "react";
import QRCode from "qrcode";

interface LabelPreviewProps {
  title: string;
  lines: string[];
  qrValue?: string;
}

export function LabelPreview({ title, lines, qrValue }: LabelPreviewProps) {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      if (!qrValue) {
        setQrDataUrl(null);
        return;
      }
      try {
        const url = await QRCode.toDataURL(qrValue, { margin: 1, scale: 4 });
        if (active) setQrDataUrl(url);
      } catch (_) {
        if (active) setQrDataUrl(null);
      }
    })();
    return () => { active = false; };
  }, [qrValue]);

  return (
    <div className="w-full rounded-md border bg-muted/30 p-3">
      <div className="text-xs font-medium text-muted-foreground mb-2">{title}</div>
      <div className="flex items-center gap-3">
        {qrDataUrl && (
          <img src={qrDataUrl} alt={`${title} QR`} className="w-16 h-16 rounded" />
        )}
        <div className="flex-1 text-sm leading-tight">
          {lines.map((l, i) => (
            <div key={i} className={i === 0 ? "font-semibold" : "text-muted-foreground"}>
              {l}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
