# iOS app (Capacitor)

The iOS app wraps the same React frontend with [Capacitor](https://capacitorjs.com), so there's one
codebase for web + iOS. The web build (`dist`) is the app; native camera and printing are added via
plugins. Run these steps on a Mac **with Xcode + CocoaPods** and enough free disk.

## One-time setup

```bash
# Install Capacitor + the plugins we use
npm install @capacitor/core @capacitor/cli @capacitor/ios @capacitor/camera

# Generate the native iOS project (uses capacitor.config.json at the repo root)
npm run ios:add
```

## Build / run cycle

```bash
npm run ios:sync      # builds the web app and copies it into the iOS project
npm run ios:open      # opens the workspace in Xcode
```

In Xcode: select a simulator or device → Run. To release, set the Team/signing, bump the version,
Archive, and upload via the Organizer (same flow as any App Store app).

## Config

- App id / name / web dir live in `capacitor.config.json` (`app.toolvision.inventory`,
  "Tool Vision Inventory", `dist`).
- The app reads the same env vars at build time (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`,
  `VITE_VISION_API_URL`) — set them before `npm run ios:sync`.

## Camera

The photo pickers already use `<input type="file" accept="image/*">`, which opens the camera in the
iOS WebView, so recognition and space-mapping work out of the box. For a nicer native capture,
swap those inputs for `@capacitor/camera`'s `Camera.getPhoto()` (returns a data URL that feeds
straight into `src/lib/vision.ts`).

## Printing on iOS

WebUSB does not exist on iOS, so the browser printing path (`src/lib/brotherPrint.ts`) is web-only.
On iOS use one of:
- **AirPrint** the rendered label image (share sheet), or
- Brother's official iOS SDK via a small Capacitor plugin (for direct QL/PT printing).

Ship label preview + AirPrint for v1; add the Brother SDK bridge as a fast-follow.

## App Store notes

- Requires a privacy manifest and camera usage string (`NSCameraUsageDescription`) — add in Xcode.
- Sign in with Apple is only required if you keep a third-party login (Google). Email-only avoids it.
