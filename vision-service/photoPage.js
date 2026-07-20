// Phone photo capture for items catalogued through the Claude app.
//
// WHY THIS EXISTS: an image the user uploads in the Claude app cannot reach a tool — tool arguments
// are JSON the model writes, and it has no way to re-emit the raw bytes. So a tool catalogued from a
// photo ends up with no photo. This page closes that gap: catalog_tool hands back a link, you open
// it on the phone you already have in your hand, and shoot the items that are missing one.
//
// WHY IT IS SERVED FROM THE WORKER and not the desktop connector: the connector's existing /capture
// page is plain http over the LAN, which is not a secure context, so `capture=environment` cannot
// open the camera and it only works on the same Wi-Fi. This is HTTPS on the public internet, so the
// camera works and it works from the garage, the driveway, or anywhere on cellular.
//
// Images are downscaled IN THE BROWSER before upload (long edge 1024, JPEG q0.72) — a modern phone
// photo is 3-5MB and none of that detail survives on a label or a thumbnail.

const BUCKET = "inventory-images"; // same bucket the web app writes to

const html = (body, status = 200) =>
  new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });

const json = (status, obj) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

async function sb(env, method, path, { params, body, prefer, raw, contentType } = {}) {
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  const url = new URL(`${env.SUPABASE_URL}/${path}`);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      ...(contentType ? { "Content-Type": contentType } : {}),
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 160)}`);
  return text ? JSON.parse(text) : null;
}

/** Items with no photo yet, newest first — the ones worth shooting while they're fresh in mind. */
export async function pendingPhotos(env, owner, limit = 60) {
  return (await sb(env, "GET", "rest/v1/items", {
    params: {
      owner_id: `eq.${owner}`,
      photo_path: "is.null",
      select: "id,name,brand,category,qr_code",
      order: "created_at.desc",
      limit: String(limit),
    },
  })) || [];
}

/** Store the JPEG in the public bucket and point the item at it. */
async function attachPhoto(env, owner, itemId, dataUrl) {
  const b64 = dataUrl.split(",", 2)[1] || "";
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  if (!bytes.length) throw new Error("empty image");
  if (bytes.length > 4_000_000) throw new Error("image too large");

  const path = `${owner}/${itemId}-${Date.now()}.jpg`;
  await sb(env, "POST", `storage/v1/object/${BUCKET}/${path}`, {
    raw: bytes,
    contentType: "image/jpeg",
  });
  const publicUrl = `${env.SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`;
  // Scope the update by owner as well as id: the service-role key bypasses RLS, so the row filter is
  // the only thing enforcing ownership here.
  await sb(env, "PATCH", "rest/v1/items", {
    params: { id: `eq.${itemId}`, owner_id: `eq.${owner}` },
    body: { photo_path: publicUrl },
    prefer: "return=minimal",
    contentType: "application/json",
  });
  return publicUrl;
}

function page(token) {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,maximum-scale=1">
<title>Add photos — Tool Vision</title>
<style>
  :root { color-scheme: dark; --bg:#14171c; --tile:#1c2129; --line:#2b323d; --ink:#e8ecf2; --dim:#9aa5b4; --hi:#ff7a1a; }
  * { box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
  body { margin:0; background:var(--bg); color:var(--ink);
         font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
         padding:env(safe-area-inset-top) 0 calc(env(safe-area-inset-bottom) + 16px); }
  header { padding:18px 20px 10px; }
  h1 { margin:0; font-size:20px; letter-spacing:-.01em; }
  .sub { color:var(--dim); font-size:14px; margin-top:4px; }
  ul { list-style:none; margin:8px 0 0; padding:0 12px; }
  li { background:var(--tile); border:1px solid var(--line); border-radius:14px;
       margin:8px 0; padding:14px 16px; display:flex; align-items:center; gap:12px; }
  .nm { font-weight:600; }
  .meta { color:var(--dim); font-size:13px; margin-top:2px; }
  .grow { flex:1; min-width:0; }
  .nm,.meta { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  button { font:inherit; font-weight:600; border:0; border-radius:11px; padding:11px 15px;
           background:var(--hi); color:#160d05; }
  button:active { opacity:.65; }
  li.done { opacity:.5; }
  li.done button { background:#2f6b3a; color:#dff5e3; }
  .empty { text-align:center; color:var(--dim); padding:64px 24px; }
  .err { background:#4a1f22; border-color:#7d3238; }
  input[type=file] { display:none; }
  .thumb { width:44px; height:44px; border-radius:9px; object-fit:cover; background:#0e1116; }
</style></head><body>
<header>
  <h1>Add photos</h1>
  <div class="sub" id="sub">Loading…</div>
</header>
<ul id="list"></ul>
<input type="file" id="picker" accept="image/*" capture="environment">
<script>
const TOKEN = ${JSON.stringify(token)};
let pending = [], current = null;

const el = (t, c) => { const e = document.createElement(t); if (c) e.className = c; return e; };

async function load() {
  const r = await fetch('/photo/' + TOKEN + '/pending');
  if (!r.ok) { document.getElementById('sub').textContent = 'Could not load (' + r.status + ')'; return; }
  pending = (await r.json()).items || [];
  render();
}

function render() {
  const list = document.getElementById('list');
  list.textContent = '';
  document.getElementById('sub').textContent = pending.length
    ? pending.length + ' item' + (pending.length === 1 ? '' : 's') + ' without a photo'
    : 'Everything has a photo.';
  if (!pending.length) {
    const d = el('div', 'empty'); d.textContent = 'Nothing to shoot right now.'; list.append(d); return;
  }
  for (const it of pending) {
    const li = el('li'); li.dataset.id = it.id;
    const g = el('div', 'grow');
    const n = el('div', 'nm'); n.textContent = it.name;
    const m = el('div', 'meta');
    m.textContent = [it.brand, it.category, it.qr_code].filter(Boolean).join(' · ');
    g.append(n, m);
    const b = el('button'); b.textContent = 'Photo';
    b.onclick = () => { current = it; document.getElementById('picker').click(); };
    li.append(g, b);
    list.append(li);
  }
}

// Downscale before upload: a phone photo is several MB and none of that detail survives on a
// thumbnail or a label. Long edge 1024 keeps it recognisable at ~100KB.
function shrink(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const max = 1024, s = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL('image/jpeg', 0.72));
    };
    img.onerror = () => reject(new Error('could not read that image'));
    img.src = URL.createObjectURL(file);
  });
}

document.getElementById('picker').onchange = async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file || !current) return;
  const item = current, li = document.querySelector('li[data-id="' + item.id + '"]');
  const btn = li && li.querySelector('button');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    const dataUrl = await shrink(file);
    const r = await fetch('/photo/' + TOKEN + '/attach', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId: item.id, imageDataUrl: dataUrl }),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || ('HTTP ' + r.status));
    const out = await r.json();
    if (li) {
      li.classList.add('done'); li.classList.remove('err');
      const t = el('img', 'thumb'); t.src = out.url; li.prepend(t);
      if (btn) { btn.textContent = 'Saved'; }
    }
    // Drop it from the working set so a reload doesn't offer it again.
    pending = pending.filter((p) => p.id !== item.id);
    document.getElementById('sub').textContent = pending.length
      ? pending.length + ' item' + (pending.length === 1 ? '' : 's') + ' without a photo'
      : 'Everything has a photo.';
  } catch (err) {
    if (li) li.classList.add('err');
    if (btn) { btn.disabled = false; btn.textContent = 'Retry'; }
    alert("Couldn't save that photo: " + err.message);
  }
  current = null;
};

load();
</script></body></html>`;
}

/**
 * Routes: GET /photo/<token> (the page) · GET /photo/<token>/pending · POST /photo/<token>/attach
 *
 * Same token as the MCP endpoint. It sits in the URL for the same reason it does there — this link
 * gets opened by tapping it on a phone, where there is nowhere to put a header.
 */
export async function handlePhoto(request, env, url, tokenMatches) {
  const parts = url.pathname.split("/").filter(Boolean); // ["photo", token, action?]
  const token = parts[1] || "";
  const action = parts[2] || "";
  if (!tokenMatches(token)) return html("<h1>Not found</h1>", 404);
  if (!env.MCP_OWNER_ID) return html("<h1>Not configured</h1>", 503);
  const owner = env.MCP_OWNER_ID;

  try {
    if (!action && request.method === "GET") return html(page(token));

    if (action === "pending" && request.method === "GET") {
      return json(200, { items: await pendingPhotos(env, owner) });
    }

    if (action === "attach" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      if (!body.itemId || !body.imageDataUrl) return json(400, { error: "itemId and imageDataUrl required" });
      const publicUrl = await attachPhoto(env, owner, body.itemId, body.imageDataUrl);
      return json(200, { ok: true, url: publicUrl });
    }
  } catch (e) {
    return json(500, { error: String(e.message || e).slice(0, 160) });
  }
  return html("<h1>Not found</h1>", 404);
}
