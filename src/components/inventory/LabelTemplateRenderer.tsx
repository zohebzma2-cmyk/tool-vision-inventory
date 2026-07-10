import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { renderTokens, type LabelTemplate, type LabelData } from "@/lib/labelTemplates";

interface Props {
  template: LabelTemplate;
  data: LabelData;
  /** px per mm for the rendered preview (default 4). */
  pxPerMm?: number;
  className?: string;
}

/**
 * Renders a label template to an SVG using percentage-positioned elements.
 * Resolution-independent, so the same template previews on screen and can later feed the printer.
 */
export function LabelTemplateRenderer({ template, data, pxPerMm = 4, className }: Props) {
  const [qrUrl, setQrUrl] = useState<string | null>(null);

  const qrValue = data.qr ?? "";
  useEffect(() => {
    let active = true;
    (async () => {
      if (!qrValue || !template.elements.some((e) => e.type === "qr")) {
        setQrUrl(null);
        return;
      }
      try {
        const url = await QRCode.toDataURL(qrValue, { margin: 0, scale: 6 });
        if (active) setQrUrl(url);
      } catch {
        if (active) setQrUrl(null);
      }
    })();
    return () => {
      active = false;
    };
  }, [qrValue, template]);

  const wMm = template.widthMm || 62;
  const hMm = template.heightMm || 24; // continuous -> a sensible preview length
  const W = wMm * pxPerMm;
  const H = hMm * pxPerMm;

  return (
    <svg
      className={className}
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label="Label preview"
      style={{ background: "white", border: "1px solid #e5e7eb", borderRadius: 4 }}
    >
      {template.elements.map((el) => {
        const x = (el.x / 100) * W;
        const y = (el.y / 100) * H;
        const w = (el.w / 100) * W;
        const h = (el.h / 100) * H;
        const fill = el.color === "red" ? "#d40000" : "#111111";

        if (el.type === "qr") {
          return qrUrl ? (
            <image key={el.id} href={qrUrl} x={x} y={y} width={w} height={h} preserveAspectRatio="xMidYMid meet" />
          ) : (
            <rect key={el.id} x={x} y={y} width={w} height={h} fill="none" stroke="#d1d5db" strokeDasharray="3 3" />
          );
        }

        const text = renderTokens(el.value ?? "", data);
        const fontSize = Math.max(6, h * 0.72 * (el.fontScale ?? 1));
        const anchor = el.align === "center" ? "middle" : el.align === "right" ? "end" : "start";
        const tx = el.align === "center" ? x + w / 2 : el.align === "right" ? x + w : x;
        return (
          <text
            key={el.id}
            x={tx}
            y={y + h / 2}
            fontSize={fontSize}
            fontWeight={el.bold ? 700 : 400}
            fontFamily="Helvetica, Arial, sans-serif"
            fill={fill}
            textAnchor={anchor}
            dominantBaseline="central"
          >
            {text}
          </text>
        );
      })}
    </svg>
  );
}
