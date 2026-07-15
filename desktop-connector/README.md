# Tool Vision desktop print connector

Bridges the web app (and terminal) to a USB Brother QL-800 through macOS CUPS, so the browser
never needs WebUSB and the app + terminal can both print without fighting over the USB device.

## One-time setup
1. Create the CUPS queue (no sudo needed if you're in the `_lpadmin`/admin group):
   ```
   lpadmin -p ToolVision_QL800 -E -v "usb://Brother/QL-800?serial=YOURSERIAL" -m drv:///sample.drv/generic.ppd
   ```
   (Find the serial with: `lpinfo -v | grep QL-800`)
2. Install deps in a venv:
   ```
   python3 -m venv venv && ./venv/bin/pip install brother_ql pyusb pillow
   ```

## Run
```
./venv/bin/python connector.py     # serves http://127.0.0.1:17777
```
The web app auto-detects it (GET /health) and prints through it (POST /print with the rendered
label PNG). Print from the terminal any time with `lp -d ToolVision_QL800 -o raw label.prn`.

Note: only one owner of the USB device at a time — if the browser has claimed the QL-800 via
WebUSB (old "Setup Printer" flow), reload the app tab so it releases and prints via the connector.
