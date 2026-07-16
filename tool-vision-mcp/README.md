# Tool Vision MCP connector

An **official MCP server** that gives Claude full, headless control of the Tool Vision garage
inventory — no browser, no Playwright. It runs locally on the Mac (stdio) so it can reach **both**
the cloud (Supabase, the vision Worker) and the **local** desktop connector (the QL-800 printer and
the phone-capture photos) — a remote worker couldn't touch the local hardware.

## Tools
- `list_locations`, `create_location`, `create_bin_wall`, `delete_location`
- `list_items`, `create_item`, `place_item`
- `request_phone_photo`, `list_captured_photos` (the phone-capture bridge)
- `print_label` (QL-800 via the desktop connector)
- `mint_short_code`

All Supabase writes use the service-role key and are stamped with the owner's user id, so everything
lands in the owner's own account (owner-scoped, exactly like the app).

## Setup (one time)
1. Fill `tool-vision-mcp/.env` (gitignored) — copy from `.env.example`:
   ```
   SUPABASE_URL=https://YOUR-PROJECT.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=<the service_role secret from Supabase → Settings → API>
   TOOLVISION_OWNER_EMAIL=you@example.com
   CONNECTOR_URL=http://127.0.0.1:17777
   ```
2. Install the SDK (once): `~/.tool-vision-connector/venv/bin/pip install mcp`
3. `.mcp.json` at the repo root registers the server for Claude Code:
   ```json
   { "mcpServers": { "tool-vision": {
       "command": "/path/to/.tool-vision-connector/venv/bin/python",
       "args": ["/path/to/tool-vision-inventory/tool-vision-mcp/server.py"] } } }
   ```
4. Restart Claude Code — it will pick up the `tool-vision` connector and its 11 tools appear as
   `mcp__tool-vision__*`.

## Phone capture
The desktop connector serves the capture page at `http://<mac>.local:17777/capture`. Open it on the
phone; the native camera opens; photos upload to `~/.tool-vision-connector/captures` for Claude to
read. `request_phone_photo("...")` shows a prompt on that page.

Requires the desktop connector (`com.toolvision.connector` LaunchAgent) to be running.
