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
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

/** The single owner this connector acts for. Everything is scoped to them. */
async function ownerId(env) {
  if (env.MCP_OWNER_ID) return env.MCP_OWNER_ID;
  throw new Error("MCP is not configured: MCP_OWNER_ID is unset.");
}

const esc = (s) => String(s).replace(/[(),"]/g, " ").trim();

/* ------------------------------------------------------------------ shared lookups */

/** Resolve a bin by its short code, its exact name, or a partial name — in that order. */
async function findBin(env, owner, ref) {
  const needle = esc(ref);
  const tries = [
    { qr_code: `eq.${needle.toUpperCase()}` },
    { name: `ilike.${needle}` },
    { name: `ilike.*${needle}*` },
  ];
  for (const filter of tries) {
    const rows = await sb(env, "GET", "locations", {
      params: {
        owner_id: `eq.${owner}`,
        select: "id,name,type,qr_code,category,parent_location_id",
        limit: "5",
        ...filter,
      },
    });
    if (rows?.length) return rows;
  }
  return [];
}

/** Walk parents to a readable path, e.g. "Garage · 6.5qt Bin Wall · Bin 3". */
async function pathOf(env, owner, loc) {
  const parts = [loc.name];
  let cur = loc, guard = 0;
  while (cur?.parent_location_id && guard++ < 6) {
    const [p] = await sb(env, "GET", "locations", {
      params: { owner_id: `eq.${owner}`, id: `eq.${cur.parent_location_id}`, select: "id,name,parent_location_id", limit: "1" },
    });
    if (!p) break;
    parts.unshift(p.name);
    cur = p;
  }
  return parts.join(" · ");
}

/** Crockford-ish short code, matching the app's shortcode alphabet (no 0/O/1/I/L). */
function mintCode() {
  const A = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
  let out = "";
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  for (const b of bytes) out += A[b % A.length];
  return out;
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
      "Find where a tool or part is stored. Use whenever the user asks where something is, " +
      "whether they own one, or what is in a particular place. Returns each match with the bin it " +
      "lives in and the full location path.",
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
      "File a tool into a bin and print its label. Use this after identifying a tool from a photo " +
      "the user sent. Identify the item yourself from the image — do not ask the user to describe " +
      "it. Always confirm the bin with the user before calling if they did not name one.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "What the tool is, e.g. 'DeWalt Chalk Line'" },
        bin: { type: "string", description: "Bin name or code to store it in" },
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

async function callTool(env, name, args) {
  const owner = await ownerId(env);

  switch (name) {
    case "find_tool": {
      const q = esc(args.query || "");
      if (!q) return "Give me something to search for.";
      const items = await sb(env, "GET", "items", {
        params: {
          owner_id: `eq.${owner}`,
          or: `(name.ilike.*${q}*,brand.ilike.*${q}*,model.ilike.*${q}*,category.ilike.*${q}*)`,
          select: "id,name,brand,model,category,quantity,qr_code",
          limit: "12",
        },
      });
      if (!items?.length) return `Nothing in the inventory matches “${args.query}”.`;

      const lines = [];
      for (const it of items) {
        const links = await sb(env, "GET", "item_locations", {
          params: { item_id: `eq.${it.id}`, date_removed: "is.null", select: "location_id,quantity", limit: "3" },
        });
        let where = "not filed anywhere yet";
        if (links?.length) {
          const [loc] = await sb(env, "GET", "locations", {
            params: { id: `eq.${links[0].location_id}`, select: "id,name,parent_location_id", limit: "1" },
          });
          if (loc) where = await pathOf(env, owner, loc);
        }
        const bits = [it.brand, it.model].filter(Boolean).join(" ");
        lines.push(`• ${it.name}${bits ? ` (${bits})` : ""} — ${where}${it.qr_code ? ` [${it.qr_code}]` : ""}`);
      }
      return lines.join("\n");
    }

    case "list_locations": {
      const rows = await sb(env, "GET", "locations", {
        params: { owner_id: `eq.${owner}`, select: "id,name,type,qr_code,category,parent_location_id", order: "name", limit: "400" },
      });
      const byId = new Map((rows || []).map((r) => [r.id, r]));
      const parents = new Set((rows || []).map((r) => r.parent_location_id).filter(Boolean));
      const label = (r) => {
        const trail = [];
        let cur = r, guard = 0;
        while (cur?.parent_location_id && guard++ < 6) {
          cur = byId.get(cur.parent_location_id);
          if (cur) trail.unshift(cur.name);
        }
        return `${trail.length ? `${trail.join(" · ")} · ` : ""}${r.name}`;
      };
      // Leaves are where things can actually be filed — call that out so the model picks one.
      const leaves = (rows || []).filter((r) => r.type !== "space" && !parents.has(r.id));
      const containers = (rows || []).filter((r) => parents.has(r.id));
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
      const [bin] = await findBin(env, owner, args.bin || "");
      if (!bin) return `I can't find a bin called “${args.bin}”. Use list_locations to see what exists.`;
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
        return `Saved “${item.name}” but could NOT file it into ${bin.name}: ${e.message}. It needs a home.`;
      }
      const where = await pathOf(env, owner, bin);
      const queued = await queueLabel(env, owner, {
        title: item.name,
        lines: [args.category, [args.brand, args.model].filter(Boolean).join(" "), qty > 1 ? `Qty ${qty}` : ""].filter(Boolean),
        qr: code,
      }, "claude-app:catalog");
      return `Filed “${item.name}”${qty > 1 ? ` ×${qty}` : ""} into ${where}. Code ${code}. ` +
        (queued ? "Label queued — it prints on the Mac." : "Could not queue a label; print it from the app.");
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
 * Handle one MCP request. Auth accepts the token either as an `Authorization: Bearer` header or as
 * a trailing path segment (`/mcp/<token>`) — the Claude app's connector UI takes a URL, and does not
 * always let you set a custom header, so the path form is the one that reliably works.
 */
export async function handleMcp(request, env, url, cors) {
  const expected = env.MCP_TOKEN;
  if (!expected) return new Response(JSON.stringify({ error: "MCP not configured" }), { status: 503, headers: { ...cors, "Content-Type": "application/json" } });

  const bearer = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const fromPath = url.pathname.replace(/^\/mcp\/?/, "");
  if (!tokenMatches(bearer, expected) && !tokenMatches(fromPath, expected)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...cors, "Content-Type": "application/json" } });
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
          // the user what went wrong and try something else instead of the turn dying.
          return rpcOk(id, { content: [{ type: "text", text: `That didn't work: ${e.message}` }], isError: true });
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
