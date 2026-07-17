import { supabase } from "@/integrations/supabase/client";
import { toast } from "@/hooks/use-toast";

// Object-storage home for item + location photos. Image bytes used to live as base64 `data:` URLs
// inside TEXT columns (items.photo_path / locations.image_path), which bloats every row. They now
// live in this bucket and the columns hold a plain URL. Reads are public (unguessable UUID paths),
// so <img src> works without signed URLs; writes are owner-scoped by the RLS policies in the
// 20260716000000_inventory_images_bucket migration.
const BUCKET = "inventory-images";

// Warn at most once per session if the bucket isn't set up yet — loud, but not spammy.
let warnedMissingBucket = false;

/**
 * Persist a captured image and return the value to store in a `*_path` column.
 *
 * - Already an http(s) URL  → returned unchanged (idempotent; safe to re-run on existing rows).
 * - A `data:` URL           → uploaded to Storage; returns the public URL.
 * - Anything else / empty   → returned as-is (or null).
 *
 * If the Storage bucket hasn't been created yet (migration not applied), this degrades to the
 * previous behavior — storing the inline `data:` URL — and warns ONCE, visibly. It never fails a
 * save for a missing bucket. Any *other* upload error is thrown so it surfaces instead of quietly
 * shipping an item/bin without its image.
 */
export async function persistInventoryImage(
  image: string | null | undefined,
  kind: "item" | "bin",
): Promise<string | null> {
  if (!image) return null;
  if (/^https?:\/\//i.test(image)) return image; // already stored
  if (!image.startsWith("data:")) return image; // unknown shape — keep it verbatim

  let blob: Blob;
  try {
    blob = dataUrlToBlob(image);
  } catch {
    return image; // unparseable data URL — don't lose it, store inline
  }

  const { data: auth } = await supabase.auth.getUser();
  const uid = auth.user?.id;
  if (!uid) return image; // not signed in (shouldn't happen under RLS) — keep inline rather than drop

  const ext = (blob.type.split("/")[1] || "jpg").replace("jpeg", "jpg");
  const path = `${uid}/${kind}/${cryptoRandomId()}.${ext}`;

  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, blob, { contentType: blob.type, upsert: false });

  if (error) {
    if (isBucketMissing(error.message)) {
      if (!warnedMissingBucket) {
        warnedMissingBucket = true;
        console.warn(
          `[imageStorage] bucket "${BUCKET}" not found — storing photos inline for now. ` +
            `Apply the inventory-images migration to move images into Storage.`,
        );
        try {
          toast({
            title: "Image storage not set up yet",
            description: `Photos are being stored inline. Apply the "${BUCKET}" migration for scalable image storage.`,
          });
        } catch {
          /* toast unavailable outside the app shell — the console.warn still fires */
        }
      }
      return image; // graceful, non-silent degrade
    }
    throw error; // a real failure (network, RLS, quota) must surface, not be swallowed
  }

  return supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
}

function isBucketMissing(message: string): boolean {
  return /bucket.*not.*found|not\s*found|does not exist/i.test(message);
}

function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) throw new Error("not a data URL");
  const mime = dataUrl.slice(0, comma).match(/data:([^;]+)/)?.[1] || "image/jpeg";
  const bytes = atob(dataUrl.slice(comma + 1));
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

function cryptoRandomId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  // Fallback for the rare non-secure context: timestamp + random suffix (uniqueness, not security).
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
