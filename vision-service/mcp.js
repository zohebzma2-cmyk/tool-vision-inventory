// Remote MCP server — lets the Claude app read and write the inventory directly.
//
// WHY THIS LIVES ON THE WORKER, not on the Mac: a custom connector must be reachable from
// Anthropic's infrastructure over the public internet. The desktop connector is on localhost behind
// a home router and can never satisfy that. So the Worker is the public face, and anything needing
// the printer is enqueued to `print_jobs`, which the always-running Mac connector drains.
//
// WHY NO IMAGE TOOLS: an image the user uploads in the Claude app cannot be forwarded into a tool
// call — tool arguments are JSON the model writes, and it has no way to re-emit the raw bytes. That
// is fine, and in fact better: Claude reads the photo itself and calls `catalog_tool` with what it
// sees, so there is no second, weaker vision model in the loop.
//
// Transport is Streamable HTTP: a single POST endpoint speaking JSON-RPC 2.0.

import { pendingPhotos } from "./photoPage.js";

const PROTOCOL_VERSION = "2025-06-18";

/* ------------------------------------------------------------------ Supabase helpers */

/**
 * Every query here runs with the service-role key, which bypasses RLS — so ownership is NOT
 * enforced by the database on this path. Each call must therefore scope by owner_id explicitly.
 * `sb()` is deliberately the only way to reach Supabase in this file so that rule has one home.
 */
async function sb(env, method, path, { params, body, prefer } = {}) {
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("MCP is not configured: SUPABASE_SERVICE_ROLE_KEY is unset.");
  const url = new URL(`${env.SUPABASE_URL}/rest/v1/${path}`);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: prefer || "return=representation",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${safeDetail(text)}`);
  return text ? JSON.parse(text) : null;
}

/**
 * Strip anything key-shaped from a string that is about to be shown to someone.
 *
 * A backstop, not the primary defence: the service-role key travels in a header and is never
 * expected in an error body. This exists so that if that ever stops being true, the secret does not
 * silently ride out to the model.
 */
export function redact(s) {
  return String(s || "")
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g, "[redacted]")      // JWTs (anon / service-role keys)
    .replace(/\bsb_[a-z]+_[A-Za-z0-9_-]{10,}\b/g, "[redacted]")   // new-format Supabase keys
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[redacted]")             // any other long opaque token
    .slice(0, 160);
}

/**
 * Reduce an UPSTREAM error body to something safe to surface.
 *
 * Whatever this returns can end up in the model's reply, and therefore in conversation history and
 * logs — so it must not be a pass-through for an arbitrary upstream payload. Keep only PostgREST's
 * short `message` field; `details` and `hint` are dropped because they quote row data.
 */
export function safeDetail(text) {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed?.message === "string" && parsed.message) return redact(parsed.message);
  } catch {
    /* not JSON — deliberately fall through rather than echoing an unknown body */
  }
  return "request rejected";
}

/** The single owner this connector acts for. Everything is scoped to them. */
async function ownerId(env) {
  if (env.MCP_OWNER_ID) return env.MCP_OWNER_ID;
  throw new Error("MCP is not configured: MCP_OWNER_ID is unset.");
}

const esc = (s) => String(s).replace(/[(),"]/g, " ").trim();

/* ------------------------------------------------------------------ shared lookups */

/**
 * Load the whole location table ONCE per request and resolve everything in memory.
 *
 * This is the difference between a snappy tool and a sluggish one. Resolving a bin used to cost up
 * to three sequential queries (code, then exact name, then partial), and building a path cost one
 * query PER ANCESTOR LEVEL, per result — so a five-result search was ~15 sequential round trips at
 * ~150ms each. A whole garage is a few hundred rows and a single query, so the tree belongs in
 * memory and the round trips collapse to one.
 *
 * Cached PER CALL, never across calls. `env` itself is reused for the isolate's whole lifetime
 * (minutes), so caching there would happily answer with a tree from before the user moved something.
 * callTool hands each invocation its own `Object.create(env)` so this cache dies with the call.
 */
async function loadTree(env, owner) {
  if (Object.prototype.hasOwnProperty.call(env, "__tree")) return env.__tree;
  const rows = await sb(env, "GET", "locations", {
    params: {
      owner_id: `eq.${owner}`,
      select: "id,name,type,qr_code,category,parent_location_id,is_slot",
      limit: "2000",
    },
  }) || [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const pathOf = (loc) => {
    const parts = [loc.name];
    let cur = loc, guard = 0;
    while (cur?.parent_location_id && guard++ < 8) {
      cur = byId.get(cur.parent_location_id);
      if (!cur) break;
      parts.unshift(cur.name);
    }
    return parts.join(" · ");
  };
  const tree = { rows, byId, pathOf };
  env.__tree = tree;
  return tree;
}

/** Resolve a bin by short code, exact name, then partial name — all against the in-memory tree. */
async function findBin(env, owner, ref) {
  const needle = esc(ref).toLowerCase();
  if (!needle) return [];
  const { rows } = await loadTree(env, owner);
  const byCode = rows.filter((r) => (r.qr_code || "").toLowerCase() === needle);
  if (byCode.length) return byCode;
  const exact = rows.filter((r) => r.name.toLowerCase() === needle);
  if (exact.length) return exact;
  return rows.filter((r) => r.name.toLowerCase().includes(needle)).slice(0, 5);
}

/** Readable path, e.g. "Garage · 6.5qt Bin Wall · Bin 3". */
async function pathOf(env, owner, loc) {
  const { pathOf: p } = await loadTree(env, owner);
  return p(loc);
}

/**
 * Normalise text for matching. Garage vocabulary is inconsistent in specific, predictable ways —
 * "6in" vs "6 inch" vs '6"', "3/8" vs "3 8" — so fold those together rather than pretending a
 * substring match will cope.
 */
function norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/["”]/g, " inch ")
    .replace(/\b(\d+)\s*(in|inch|inches)\b/g, "$1in")
    .replace(/\b(\d+)\s*(mm|millimet(er|re)s?)\b/g, "$1mm")
    .replace(/[^a-z0-9/.]+/g, " ")
    .trim();
}

const tokens = (s) => norm(s).split(" ").filter(Boolean);

/**
 * Score one item against the query tokens. Higher is better; 0 means "no signal at all".
 *
 * Deliberately token-based rather than a single substring: "6 inch backing pad" should find
 * "Backing Pad 6in", which no `ilike '%...%'` can do. A prefix match counts for less than a whole
 * word so "pad" ranks an actual pad above "Padlock", and the name is weighted above brand/model
 * because that is what people actually search by.
 */
function scoreItem(item, qTokens) {
  const name = norm(item.name);
  const rest = norm([item.brand, item.model, item.category, item.notes].filter(Boolean).join(" "));
  const nameWords = new Set(name.split(" "));
  let score = 0;
  for (const t of qTokens) {
    if (nameWords.has(t)) score += 10;
    else if (name.includes(t)) score += 6;
    else if (rest.split(" ").includes(t)) score += 4;
    else if (rest.includes(t)) score += 2;
  }
  // Reward matching most of what was asked for, so a 3-of-3 match beats a 1-of-3 on a longer name.
  const matched = qTokens.filter((t) => name.includes(t) || rest.includes(t)).length;
  if (matched === qTokens.length) score += 8;
  return score;
}

/** A tappable link to the photo-capture page, using the first configured token. */
function photoLink(env) {
  const t = String(env.MCP_TOKEN || "").split(",")[0].trim();
  return `${env.PUBLIC_BASE_URL || "https://tool-vision.zoalvi.workers.dev"}/photo/${t}`;
}

/** Crockford-ish short code, matching the app's shortcode alphabet (no 0/O/1/I/L). */
function mintCode() {
  const A = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
  let out = "";
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  for (const b of bytes) out += A[b % A.length];
  return out;
}

/**
 * Pick a home for an item nobody named a bin for.
 *
 * Preference order: a bin whose own category matches the item's, then the emptiest leaf. Returns the
 * reason alongside, because a filing decision the user can't see is a filing decision they can't
 * correct — the response always says which bin and why, and move_tool fixes it in one call.
 */
async function suggestBin(env, owner, item) {
  const { rows } = await loadTree(env, owner);
  const parents = new Set(rows.map((r) => r.parent_location_id).filter(Boolean));
  const leaves = rows.filter((r) => r.type !== "space" && !parents.has(r.id));
  if (!leaves.length) return null;

  const want = norm(item.category || "");
  if (want) {
    const byTheme = leaves.filter((r) => {
      const c = norm(r.category || "");
      return c && (c === want || c.includes(want) || want.includes(c));
    });
    if (byTheme.length) {
      return { bin: byTheme[0], why: `it already holds ${byTheme[0].category}` };
    }
  }

  const links = await sb(env, "GET", "item_locations", {
    params: { owner_id: `eq.${owner}`, date_removed: "is.null", select: "location_id", limit: "2000" },
  });
  const used = new Set((links || []).map((l) => l.location_id));
  const empty = leaves.filter((r) => !used.has(r.id) && !r.category);
  if (empty.length) {
    // Lowest-numbered empty bin, so filing is predictable rather than scattered.
    empty.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    return { bin: empty[0], why: "it was the next empty bin" };
  }
  return null;
}

/** Queue a label for the Mac connector to print. Never throws into the caller's happy path. */
async function queueLabel(env, owner, spec, source) {
  try {
    await sb(env, "POST", "print_jobs", {
      body: [{ owner_id: owner, spec, source: source || "claude-app" }],
      prefer: "return=minimal",
    });
    return true;
  } catch {
    return false; // printing is best-effort; the catalog write already succeeded
  }
}

/* ------------------------------------------------------------------ tools */

const TOOLS = [
  {
    name: "find_tool",
    description:
      "Find where a tool or part is stored. Call this whenever the user asks where something is, " +
      "whether they own one, if they need another, or what a place contains — including vague asks " +
      "like \"do I have anything for sanding?\". Matching is token-based, so natural phrasing such as " +
      "\"6 inch backing pad\" finds \"Backing Pad 6in\"; pass the user's own words rather than " +
      "guessing at a stored name. Returns each match with its bin and full location path.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Tool name, brand, or partial name, e.g. 'chalk line'" } },
      required: ["query"],
    },
  },
  {
    name: "list_locations",
    description: "List the storage locations (spaces, shelves, racks, bins) so you can pick a valid place to file something.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "bin_contents",
    description: "List everything stored in one bin. Accepts the bin's short code or its name.",
    inputSchema: {
      type: "object",
      properties: { bin: { type: "string", description: "Bin name or 5-character code, e.g. 'Bin 3' or 'HAL22'" } },
      required: ["bin"],
    },
  },
  {
    name: "catalog_tool",
    description:
      "File a tool into a bin and print its label. Call this whenever the user sends a photo of a " +
      "tool, or says they want something put away, added, catalogued or logged. Identify the item " +
      "from the image yourself — name, brand, model and category — and pass what you can see; do " +
      "NOT ask the user to describe it back to you. If they named a bin, pass it. If they did not, " +
      "leave `bin` empty and it will be filed by category and tell you where it went — that is " +
      "preferred over asking, since the user can just say 'move it'.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "What the tool is, e.g. 'DeWalt Chalk Line'" },
        bin: { type: "string", description: "Bin name or code. Omit to file it by category automatically." },
        category: { type: "string", description: "e.g. 'marking tools', 'fasteners', 'power tools'" },
        brand: { type: "string" },
        model: { type: "string" },
        quantity: { type: "integer", description: "How many of this item. Defaults to 1." },
        notes: { type: "string", description: "Anything else worth recording, e.g. a UPC." },
      },
      required: ["name", "bin"],
    },
  },
  {
    name: "move_tool",
    description: "Move an already-catalogued tool from wherever it is into a different bin.",
    inputSchema: {
      type: "object",
      properties: {
        tool: { type: "string", description: "Name of the tool to move" },
        bin: { type: "string", description: "Destination bin name or code" },
      },
      required: ["tool", "bin"],
    },
  },
  {
    name: "set_bin_category",
    description: "Set what a bin holds (its theme). Used on labels and to spot misfiled tools.",
    inputSchema: {
      type: "object",
      properties: {
        bin: { type: "string" },
        category: { type: "string", description: "e.g. 'Marking Tools'" },
      },
      required: ["bin", "category"],
    },
  },
  {
    name: "photo_status",
    description:
      "How many catalogued items still have no photo, and the link to add them. Mention this when " +
      "the user asks about photos, or after cataloguing a batch — a photo cannot be attached from " +
      "this conversation (tool calls carry only text), so the link is the way to add one.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "print_label",
    description:
      "Print (or reprint) a label on the Brother label printer. Queues the job; the Mac prints it " +
      "as soon as it is awake and connected.",
    inputSchema: {
      type: "object",
      properties: {
        bin: { type: "string", description: "Print this bin's label" },
        tool: { type: "string", description: "Print this tool's label instead" },
      },
    },
  },
];

async function callTool(baseEnv, name, args) {
  // A per-invocation view of env. loadTree() memoises onto this, so the cache lives exactly as
  // long as one tool call — env itself outlives the request and would go stale.
  const env = Object.create(baseEnv);
  const owner = await ownerId(env);

  switch (name) {
    case "find_tool": {
      const qTokens = tokens(args.query || "");
      if (!qTokens.length) return "Give me something to search for.";

      // Rank in memory instead of with one `ilike '%q%'`. A garage's whole item list is small, and
      // substring matching cannot find "Backing Pad 6in" from "6 inch backing pad" — which is
      // exactly how people ask. Three round trips, all concurrent.
      const [all, links, tree] = await Promise.all([
        sb(env, "GET", "items", {
          params: { owner_id: `eq.${owner}`, select: "id,name,brand,model,category,notes,quantity,qr_code", limit: "1000" },
        }),
        sb(env, "GET", "item_locations", {
          params: { owner_id: `eq.${owner}`, date_removed: "is.null", select: "item_id,location_id", limit: "2000" },
        }),
        loadTree(env, owner),
      ]);

      const ranked = (all || [])
        .map((it) => ({ it, score: scoreItem(it, qTokens) }))
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score);

      if (!ranked.length) {
        return `Nothing in the inventory matches “${args.query}”.`;
      }
      // A weak top score means we matched an incidental word, not the thing asked for. Say so rather
      // than presenting a bad guess as an answer — the model can then ask instead of asserting.
      const strong = ranked.filter((r) => r.score >= 10);
      const shown = (strong.length ? strong : ranked).slice(0, 12);
      const hedge = strong.length ? "" : `No exact match for “${args.query}”. Closest:\n`;

      const placedIn = new Map();
      for (const l of links || []) if (!placedIn.has(l.item_id)) placedIn.set(l.item_id, l.location_id);

      return hedge + shown.map(({ it }) => {
        const loc = tree.byId.get(placedIn.get(it.id));
        const where = loc ? tree.pathOf(loc) : "not filed anywhere yet";
        const bits = [it.brand, it.model].filter(Boolean).join(" ");
        return `• ${it.name}${bits ? ` (${bits})` : ""} — ${where}${it.qr_code ? ` [${it.qr_code}]` : ""}`;
      }).join("\n");
    }

    case "list_locations": {
      const { rows, pathOf: label } = await loadTree(env, owner);
      const parents = new Set(rows.map((r) => r.parent_location_id).filter(Boolean));
      // Leaves are where things can actually be filed — call that out so the model picks one.
      const byName = (a, b) => a.name.localeCompare(b.name);
      const leaves = rows.filter((r) => r.type !== "space" && !parents.has(r.id)).sort(byName);
      const containers = rows.filter((r) => parents.has(r.id)).sort(byName);
      return [
        "Places that hold tools (file things HERE):",
        ...leaves.slice(0, 120).map((r) => `• ${label(r)}${r.category ? ` — holds ${r.category}` : ""}${r.qr_code ? ` [${r.qr_code}]` : ""}`),
        "",
        "Containers (not filing targets):",
        ...containers.slice(0, 40).map((r) => `• ${label(r)} (${r.type})`),
      ].join("\n");
    }

    case "bin_contents": {
      const [bin] = await findBin(env, owner, args.bin || "");
      if (!bin) return `I can't find a bin called “${args.bin}”.`;
      const links = await sb(env, "GET", "item_locations", {
        params: { location_id: `eq.${bin.id}`, date_removed: "is.null", select: "item_id,quantity", limit: "200" },
      });
      if (!links?.length) return `${await pathOf(env, owner, bin)} is empty.`;
      const ids = links.map((l) => l.item_id).join(",");
      // The tree is already cached from findBin above, so pathOf below costs nothing.
      const items = await sb(env, "GET", "items", {
        params: { id: `in.(${ids})`, select: "id,name,brand,model,quantity", limit: "200" },
      });
      const qty = new Map(links.map((l) => [l.item_id, l.quantity]));
      const body = (items || []).map((i) => {
        const n = qty.get(i.id) || 1;
        const bits = [i.brand, i.model].filter(Boolean).join(" ");
        return `• ${i.name}${bits ? ` (${bits})` : ""}${n > 1 ? ` ×${n}` : ""}`;
      });
      return `${await pathOf(env, owner, bin)}${bin.category ? ` — ${bin.category}` : ""}\n${body.join("\n")}`;
    }

    case "catalog_tool": {
      let bin = (await findBin(env, owner, args.bin || ""))[0];
      let chose = "";
      if (!bin) {
        if (args.bin) return `I can't find a bin called “${args.bin}”. Use list_locations to see what exists.`;
        // No bin named: pick one by theme rather than making the user (or the model) go look. A bin
        // whose category matches the item is the obvious home; the alternative is asking a question
        // that the data already answers. It says which and why, and move_tool undoes it in one call.
        const suggestion = await suggestBin(env, owner, args);
        if (!suggestion) {
          return "Which bin should this go in? Call list_locations to see the options — I couldn't " +
            "find one matching its category, and there are no empty bins to fall back on.";
        }
        bin = suggestion.bin;
        chose = suggestion.why;
      }
      const qty = Math.max(1, Number(args.quantity) || 1);
      const code = mintCode();
      const [item] = await sb(env, "POST", "items", {
        body: [{
          owner_id: owner,
          name: String(args.name).slice(0, 200),
          category: args.category || null,
          brand: args.brand || null,
          model: args.model || null,
          notes: args.notes || null,
          quantity: qty,
          qr_code: code,
        }],
      });
      // The item exists but is unfiled until this succeeds — surface a failure rather than
      // reporting success for something that will show up later as "homeless".
      try {
        await sb(env, "POST", "item_locations", {
          body: [{ item_id: item.id, location_id: bin.id, quantity: qty, owner_id: owner }],
          prefer: "return=minimal",
        });
      } catch (e) {
        return `Saved “${item.name}” but could NOT file it into ${bin.name} (${redact(e.message)}). It needs a home.`;
      }
      const where = await pathOf(env, owner, bin);
      const queued = await queueLabel(env, owner, {
        title: item.name,
        lines: [args.category, [args.brand, args.model].filter(Boolean).join(" "), qty > 1 ? `Qty ${qty}` : ""].filter(Boolean),
        qr: code,
      }, "claude-app:catalog");
      return `Filed “${item.name}”${qty > 1 ? ` ×${qty}` : ""} into ${where}` +
        (chose ? ` — I picked it because ${chose}; say "move it" if that's wrong` : "") + `. Code ${code}. ` +
        (queued ? "Label queued — it prints on the Mac." : "Could not queue a label; print it from the app.") +
        // A photo can't ride along on a tool call, so say so once rather than leaving the user to
        // discover later that everything catalogued this way is imageless.
        ` No photo saved (I can't attach one from here) — add photos: ${photoLink(env)}`;
    }

    case "move_tool": {
      const q = esc(args.tool || "");
      const items = await sb(env, "GET", "items", {
        params: { owner_id: `eq.${owner}`, name: `ilike.*${q}*`, select: "id,name", limit: "5" },
      });
      if (!items?.length) return `No tool matches “${args.tool}”.`;
      if (items.length > 1) return `That matches ${items.length} tools: ${items.map((i) => i.name).join(", ")}. Which one?`;
      const item = items[0];
      const [bin] = await findBin(env, owner, args.bin || "");
      if (!bin) return `I can't find a bin called “${args.bin}”.`;

      const active = await sb(env, "GET", "item_locations", {
        params: { item_id: `eq.${item.id}`, date_removed: "is.null", select: "id,location_id,quantity" },
      });
      const qty = (active || []).reduce((s, r) => s + (r.quantity || 1), 0) || 1;
      // Clear every OTHER location first. There is a UNIQUE(item_id, location_id) and removal is a
      // soft delete, so the target's own row must be REACTIVATED, never re-inserted — otherwise the
      // insert throws after the removal has committed and the tool ends up filed nowhere.
      const stale = (active || []).filter((r) => r.location_id !== bin.id).map((r) => r.id);
      if (stale.length) {
        await sb(env, "PATCH", "item_locations", {
          params: { id: `in.(${stale.join(",")})` },
          body: { date_removed: new Date().toISOString() },
          prefer: "return=minimal",
        });
      }
      const prior = await sb(env, "GET", "item_locations", {
        params: { item_id: `eq.${item.id}`, location_id: `eq.${bin.id}`, select: "id", limit: "1" },
      });
      if (prior?.length) {
        await sb(env, "PATCH", "item_locations", {
          params: { id: `eq.${prior[0].id}` },
          body: { date_removed: null, quantity: qty },
          prefer: "return=minimal",
        });
      } else {
        await sb(env, "POST", "item_locations", {
          body: [{ item_id: item.id, location_id: bin.id, quantity: qty, owner_id: owner }],
          prefer: "return=minimal",
        });
      }
      return `Moved “${item.name}” to ${await pathOf(env, owner, bin)}.`;
    }

    case "set_bin_category": {
      const [bin] = await findBin(env, owner, args.bin || "");
      if (!bin) return `I can't find a bin called “${args.bin}”.`;
      await sb(env, "PATCH", "locations", {
        params: { id: `eq.${bin.id}`, owner_id: `eq.${owner}` },
        body: { category: String(args.category).slice(0, 120) },
        prefer: "return=minimal",
      });
      return `${bin.name} now holds “${args.category}”.`;
    }

    case "photo_status": {
      const missing = await pendingPhotos(env, owner, 200);
      if (!missing.length) return "Every catalogued item has a photo.";
      const names = missing.slice(0, 8).map((i) => i.name).join(", ");
      return `${missing.length} item${missing.length === 1 ? "" : "s"} have no photo yet` +
        `${missing.length > 8 ? ` (including ${names})` : `: ${names}`}.\n` +
        `Add them here: ${photoLink(env)}`;
    }

    case "print_label": {
      if (args.bin) {
        const [bin] = await findBin(env, owner, args.bin);
        if (!bin) return `I can't find a bin called “${args.bin}”.`;
        let code = bin.qr_code;
        if (!code) {
          code = mintCode();
          await sb(env, "PATCH", "locations", { params: { id: `eq.${bin.id}` }, body: { qr_code: code }, prefer: "return=minimal" });
        }
        const ok = await queueLabel(env, owner, {
          title: bin.name, badge: (bin.name.match(/\d+/) || [""])[0],
          lines: [bin.category, await pathOf(env, owner, bin)].filter(Boolean), qr: code,
        }, "claude-app:print");
        return ok ? `Queued the label for ${bin.name}. It prints on the Mac.` : "Couldn't queue that label.";
      }
      if (args.tool) {
        const items = await sb(env, "GET", "items", {
          params: { owner_id: `eq.${owner}`, name: `ilike.*${esc(args.tool)}*`, select: "id,name,category,brand,model,qr_code", limit: "2" },
        });
        if (!items?.length) return `No tool matches “${args.tool}”.`;
        if (items.length > 1) return `That matches more than one tool. Which: ${items.map((i) => i.name).join(", ")}?`;
        const it = items[0];
        let code = it.qr_code;
        if (!code) {
          code = mintCode();
          await sb(env, "PATCH", "items", { params: { id: `eq.${it.id}` }, body: { qr_code: code }, prefer: "return=minimal" });
        }
        const ok = await queueLabel(env, owner, {
          title: it.name,
          lines: [it.category, [it.brand, it.model].filter(Boolean).join(" ")].filter(Boolean),
          qr: code,
        }, "claude-app:print");
        return ok ? `Queued the label for ${it.name}.` : "Couldn't queue that label.";
      }
      return "Tell me which bin or tool to print a label for.";
    }

    default:
      return `Unknown tool: ${name}`;
  }
}

/* ------------------------------------------------------------------ JSON-RPC plumbing */

const rpcOk = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcErr = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

/**
 * Constant-time-ish token compare. Not cryptographically perfect in a JS runtime, but it removes the
 * trivially-exploitable early-return length/prefix leak of `===` on a secret.
 */
function tokenMatches(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Handle one MCP request.
 *
 * AUTH — read this before changing it.
 *
 * The header form (`Authorization: Bearer <token>`) is the one to use. A secret in a URL path is
 * genuinely weaker: URLs get written to proxy and server access logs, kept in client-side history,
 * and pasted into bug reports far more readily than headers do, and this token grants full read AND
 * write over the inventory.
 *
 * The path form (`/mcp/<token>`) exists only because a connector UI that accepts a URL and nothing
 * else has no other way to authenticate. It is therefore OPT-OUT, not permanent: set
 * MCP_ALLOW_PATH_TOKEN="false" the moment the header form is confirmed working, and the weaker
 * door closes with no code change.
 *
 * MCP_TOKEN is comma-separated so tokens can be rotated without downtime: add the new one, move the
 * client over, then drop the old one. Issue a distinct token per client so a single leak can be
 * revoked on its own rather than cutting off everything.
 */
/** Does this candidate match any configured token? Shared with the photo-capture page. */
export function tokenMatchesAny(candidate, env) {
  return String(env.MCP_TOKEN || "").split(",").map((s) => s.trim()).filter(Boolean)
    .some((t) => tokenMatches(candidate, t));
}

export async function handleMcp(request, env, url, cors) {
  const tokens = String(env.MCP_TOKEN || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!tokens.length) return new Response(JSON.stringify({ error: "MCP not configured" }), { status: 503, headers: { ...cors, "Content-Type": "application/json" } });

  const anyMatches = (candidate) => tokens.some((t) => tokenMatches(candidate, t));
  const bearer = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  // Default-on so first-time setup works from a URL-only client; flip to "false" once headers work.
  const pathAllowed = String(env.MCP_ALLOW_PATH_TOKEN ?? "true").toLowerCase() !== "false";
  const fromPath = pathAllowed ? url.pathname.replace(/^\/mcp\/?/, "") : "";

  if (!anyMatches(bearer) && !(pathAllowed && anyMatches(fromPath))) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      // Tell a well-behaved client how to authenticate properly rather than only saying "no".
      headers: { ...cors, "Content-Type": "application/json", "WWW-Authenticate": 'Bearer realm="tool-vision"' },
    });
  }

  if (request.method === "GET") {
    // Some clients probe with GET before POSTing. Nothing to stream — say so rather than 404.
    return new Response(JSON.stringify({ ok: true, transport: "streamable-http", protocol: PROTOCOL_VERSION }), {
      status: 200, headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  let rpc;
  try { rpc = await request.json(); } catch { return new Response(JSON.stringify(rpcErr(null, -32700, "parse error")), { status: 200, headers: { ...cors, "Content-Type": "application/json" } }); }

  const respond = (payload) =>
    new Response(payload === null ? "" : JSON.stringify(payload), {
      status: payload === null ? 202 : 200,
      headers: { ...cors, "Content-Type": "application/json" },
    });

  const one = async (msg) => {
    const { id, method, params } = msg || {};
    // Notifications have no id and expect no response body.
    if (id === undefined || id === null) return null;

    switch (method) {
      case "initialize":
        return rpcOk(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "tool-vision", version: "1.0.0" },
        });
      case "ping":
        return rpcOk(id, {});
      case "tools/list":
        return rpcOk(id, { tools: TOOLS });
      case "tools/call": {
        const toolName = params?.name;
        if (!TOOLS.some((t) => t.name === toolName)) return rpcErr(id, -32602, `unknown tool: ${toolName}`);
        try {
          const text = await callTool(env, toolName, params?.arguments || {});
          return rpcOk(id, { content: [{ type: "text", text: String(text) }] });
        } catch (e) {
          // Report the failure as tool output rather than a protocol error, so the model can tell
          // the user what went wrong and try something else instead of the turn dying. The detail is
          // scrubbed first: this text goes into the conversation, so it must not be a pass-through
          // for an arbitrary upstream error body.
          return rpcOk(id, { content: [{ type: "text", text: `That didn't work: ${redact(e.message)}` }], isError: true });
        }
      }
      default:
        return rpcErr(id, -32601, `method not found: ${method}`);
    }
  };

  if (Array.isArray(rpc)) {
    const out = (await Promise.all(rpc.map(one))).filter(Boolean);
    return respond(out.length ? out : null);
  }
  return respond(await one(rpc));
}
