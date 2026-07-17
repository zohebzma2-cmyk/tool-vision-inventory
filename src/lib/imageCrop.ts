/** Crop a normalized box out of a data-URL image into a square JPEG thumbnail (cover-fit, white pad).
 * Shared by the bin-sort and overlay-scan flows. Returns undefined for a too-small/failed crop. */
export async function cropBox(
  src: string,
  box: { x: number; y: number; w: number; h: number },
  size = 256,
): Promise<string | undefined> {
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = rej;
      i.src = src;
    });
    const sx = Math.max(0, box.x * img.width), sy = Math.max(0, box.y * img.height);
    const sw = Math.min(img.width - sx, box.w * img.width), sh = Math.min(img.height - sy, box.h * img.height);
    if (sw < 8 || sh < 8) return undefined;
    const c = document.createElement("canvas");
    c.width = size; c.height = size;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, size, size);
    const scale = Math.min(size / sw, size / sh);
    const dw = sw * scale, dh = sh * scale;
    ctx.drawImage(img, sx, sy, sw, sh, (size - dw) / 2, (size - dh) / 2, dw, dh);
    return c.toDataURL("image/jpeg", 0.8);
  } catch {
    return undefined;
  }
}
