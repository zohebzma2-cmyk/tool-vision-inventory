#!/usr/bin/env python3
"""Tool Vision MCP server — the official connector that gives Claude full, headless control of the
garage inventory. It runs LOCALLY on the Mac (stdio transport) so it can reach BOTH the cloud
(Supabase, the vision Worker) AND the local desktop connector (printer + phone-capture photos) — a
remote worker couldn't touch the local hardware.

Tools: list/create locations & bins, build a bin-wall grid, list/create/place items, request a phone
photo + read captured photos, print a label, and mint unique 5-char codes. All Supabase writes use
the service-role key and are stamped with the owner's user id, so everything lands in the owner's
own account (owner-scoped, just like the app).

Config lives in tool-vision-mcp/.env (gitignored): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and
optionally TOOLVISION_OWNER_EMAIL / CONNECTOR_URL.
"""
import os, json, secrets, urllib.request, urllib.parse
from mcp.server.fastmcp import FastMCP

# --- config (load tool-vision-mcp/.env, no dependency) ---
_ENV_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
if os.path.isfile(_ENV_PATH):
    for line in open(_ENV_PATH):
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
OWNER_EMAIL = os.environ.get("TOOLVISION_OWNER_EMAIL", "")  # supplied via gitignored .env, never source
CONNECTOR = os.environ.get("CONNECTOR_URL", "http://127.0.0.1:17777").rstrip("/")
CAPTURES_DIR = os.path.expanduser("~/.tool-vision-connector/captures")

mcp = FastMCP("tool-vision")
ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"  # Crockford-ish, no 0/O/1/I/L


def _need_config():
    if not SUPABASE_URL or not SERVICE_KEY:
        raise RuntimeError("Not configured: set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in tool-vision-mcp/.env")


def _sb(method, path, body=None, params=None):
    """Supabase REST call with the service-role key."""
    _need_config()
    url = f"{SUPABASE_URL}/rest/v1/{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}",
        "Content-Type": "application/json", "Prefer": "return=representation",
    })
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read() or "null")


def _post_connector(path, body, origin="http://localhost:17777"):
    req = urllib.request.Request(f"{CONNECTOR}{path}", data=json.dumps(body).encode(),
                                 method="POST", headers={"Content-Type": "application/json", "Origin": origin})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read() or "{}")


_owner_id = None
def owner_id():
    """The owner's auth user id — inserts are stamped with it so data lands in their account."""
    global _owner_id
    if _owner_id:
        return _owner_id
    _need_config()
    req = urllib.request.Request(f"{SUPABASE_URL}/auth/v1/admin/users?per_page=200",
                                 headers={"apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}"})
    with urllib.request.urlopen(req, timeout=20) as r:
        users = json.loads(r.read())
    users = users.get("users", users) if isinstance(users, dict) else users
    for u in users:
        if (u.get("email") or "").lower() == OWNER_EMAIL.lower():
            _owner_id = u["id"]
            return _owner_id
    raise RuntimeError(f"owner {OWNER_EMAIL} not found in this project")


def mint_code():
    """A fresh 5-char code unused across items + locations."""
    for _ in range(8):
        code = "".join(secrets.choice(ALPHABET) for _ in range(5))
        loc = _sb("GET", "locations", params={"qr_code": f"eq.{code}", "select": "id", "limit": 1})
        itm = _sb("GET", "items", params={"qr_code": f"eq.{code}", "select": "id", "limit": 1})
        if not loc and not itm:
            return code
    return "".join(secrets.choice(ALPHABET) for _ in range(6))


# ---------------- location tools ----------------
@mcp.tool()
def list_locations() -> str:
    """List every storage location/bin/space in the garage inventory (name, type, code, parent, grid)."""
    rows = _sb("GET", "locations", params={
        "owner_id": f"eq.{owner_id()}",
        "select": "id,name,type,qr_code,parent_location_id,grid_rows,grid_cols,capacity,is_slot",
        "order": "name"})
    return json.dumps(rows, indent=2)


@mcp.tool()
def create_location(name: str, type: str = "bin", parent_id: str = "", capacity: int = 0) -> str:
    """Create one storage location (type: bin/rack/shelf/space/drawer/pegboard...). Returns it with its code."""
    row = {"name": name, "type": type, "qr_code": mint_code(), "is_slot": False, "owner_id": owner_id()}
    if parent_id:
        row["parent_location_id"] = parent_id
    if capacity:
        row["capacity"] = capacity
    out = _sb("POST", "locations", body=row)
    return json.dumps(out[0] if out else {}, indent=2)


@mcp.tool()
def create_bin_wall(name: str, rows: int, cols: int, place: str = "Garage", unit_type: str = "shelf") -> str:
    """Create a shelf/bin-wall in the correct Space → Shelf → Bin hierarchy: the SPACE (e.g. Garage,
    created if missing) holds a SHELF unit (`unit_type`, default "shelf"), which holds rows×cols child
    BINS. Bins are named A1..(row letter)(col number). Returns the shelf + how many bins were made."""
    oid = owner_id()
    # The space (Garage) is where the shelf lives — find or create it as a top-level "space".
    existing = _sb("GET", "locations", params={
        "owner_id": f"eq.{oid}", "name": f"eq.{place}", "select": "id", "limit": 1})
    place_id = existing[0]["id"] if existing else _sb("POST", "locations", body={
        "name": place, "type": "space", "qr_code": mint_code(), "is_slot": False,
        "layout": {"placeKind": place.lower()}, "owner_id": oid})[0]["id"]
    # The shelf unit lives IN the space.
    shelf = _sb("POST", "locations", body={
        "name": name, "type": unit_type, "qr_code": mint_code(), "is_slot": False,
        "parent_location_id": place_id, "grid_rows": rows, "grid_cols": cols, "owner_id": oid})[0]
    # The bins live ON the shelf.
    bins = [{
        "name": f"{chr(65 + r)}{c + 1}", "type": "bin", "qr_code": mint_code(), "is_slot": True,
        "parent_location_id": shelf["id"], "slot_row": r, "slot_col": c, "slot_index": r * cols + c,
        "owner_id": oid,
    } for r in range(rows) for c in range(cols)]
    _sb("POST", "locations", body=bins)
    return json.dumps({"space": place, "shelf": shelf, "bins_created": len(bins)}, indent=2)


@mcp.tool()
def delete_location(location_id: str) -> str:
    """Delete a location and its slot children (items are kept, only their links here are removed)."""
    _sb("DELETE", "item_locations", params={"location_id": f"eq.{location_id}"})
    _sb("DELETE", "locations", params={"parent_location_id": f"eq.{location_id}"})
    _sb("DELETE", "locations", params={"id": f"eq.{location_id}"})
    return json.dumps({"deleted": location_id})


@mcp.tool()
def set_bin_category(bin_name_or_code: str, category: str, parent_id: str = "") -> str:
    """Set what a bin holds (its contents category, e.g. "PPE", "Marking Tools"). This is printed on the
    bin label so the wall reads by contents. Match the bin by exact name (e.g. "Bin 3") or by its code;
    pass parent_id to disambiguate when the same bin name exists under multiple shelves."""
    params = {"select": "id,name,qr_code", "limit": "1", "is_slot": "eq.true"}
    if parent_id:
        params["parent_location_id"] = f"eq.{parent_id}"
    rows = _sb("GET", "locations", params={**params, "name": f"eq.{bin_name_or_code}"})
    if not rows:
        rows = _sb("GET", "locations", params={**params, "qr_code": f"eq.{bin_name_or_code}"})
    if not rows:
        return json.dumps({"error": f"no bin matching {bin_name_or_code!r}"})
    b = rows[0]
    _sb("PATCH", "locations", params={"id": f"eq.{b['id']}"}, body={"category": category})
    return json.dumps({"bin": b["name"], "code": b["qr_code"], "category": category})


# ---------------- item tools ----------------
@mcp.tool()
def list_items() -> str:
    """List every tool/item in the inventory (name, category, brand, size, code, quantity)."""
    rows = _sb("GET", "items", params={
        "owner_id": f"eq.{owner_id()}",
        "select": "id,name,category,brand,model,size_specs,qr_code,quantity", "order": "name"})
    return json.dumps(rows, indent=2)


@mcp.tool()
def create_item(name: str, category: str = "Other", brand: str = "", model: str = "",
                size_specs: str = "", quantity: int = 1, location_id: str = "") -> str:
    """Create a tool/item (and place it into a location if location_id is given). Returns it with its code."""
    oid = owner_id()
    row = {"name": name, "category": category, "qr_code": mint_code(), "quantity": quantity, "owner_id": oid}
    for k, v in (("brand", brand), ("model", model), ("size_specs", size_specs)):
        if v:
            row[k] = v
    item = _sb("POST", "items", body=row)[0]
    if location_id:
        _sb("POST", "item_locations", body={
            "item_id": item["id"], "location_id": location_id, "quantity": quantity, "owner_id": oid})
    return json.dumps(item, indent=2)


@mcp.tool()
def place_item(item_id: str, location_id: str, quantity: int = 1) -> str:
    """Place (or move) an item into a location."""
    oid = owner_id()
    _sb("PATCH", "item_locations",
        params={"item_id": f"eq.{item_id}", "date_removed": "is.null"},
        body={"date_removed": "now()"})
    out = _sb("POST", "item_locations", body={
        "item_id": item_id, "location_id": location_id, "quantity": quantity, "owner_id": oid})
    return json.dumps(out[0] if out else {}, indent=2)


# ---------------- phone capture + print ----------------
@mcp.tool()
def request_phone_photo(prompt: str) -> str:
    """Ask the owner's phone for a photo — shows `prompt` on the /capture page. The owner opens the
    capture page (http://<mac>.local:17777/capture) and snaps it; read it with list_captured_photos."""
    try:
        _post_connector("/capture-request", {"prompt": prompt})
        return f"Requested on the phone: {prompt}. Tell the owner to open the capture page and snap it."
    except Exception as e:
        return f"Connector not reachable ({e}). Is the desktop connector running?"


@mcp.tool()
def list_captured_photos() -> str:
    """List captured phone photos, newest first — absolute file paths Claude can read directly."""
    if not os.path.isdir(CAPTURES_DIR):
        return json.dumps([])
    files = [os.path.join(CAPTURES_DIR, f) for f in os.listdir(CAPTURES_DIR) if not f.startswith(".")]
    files.sort(key=os.path.getmtime, reverse=True)
    return json.dumps(files[:20], indent=2)


@mcp.tool()
def print_label(title: str, badge: str = "", lines: list = None, qr: str = "") -> str:
    """Print a label on the QL-800 via the desktop connector. `badge` = big code/number, `lines` =
    detail lines, `qr` = QR payload (defaults to the badge/title)."""
    spec = {"title": title, "badge": badge, "lines": lines or [], "qr": qr or badge or title}
    try:
        return json.dumps(_post_connector("/print", spec))
    except Exception as e:
        return json.dumps({"success": False, "message": f"connector unreachable: {e}"})


@mcp.tool()
def mint_short_code() -> str:
    """Mint a fresh unique 5-char code (for a new bin/item you'll create separately)."""
    return mint_code()


if __name__ == "__main__":
    mcp.run()
