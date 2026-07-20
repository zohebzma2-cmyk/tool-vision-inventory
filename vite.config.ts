import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { VitePWA } from "vite-plugin-pwa";

// https://vitejs.dev/config/
export default defineConfig(() => ({
  server: {
    host: "::",
    port: 8080,
  },
  plugins: [
    react(),
    // Installable app + offline shell. The station (iPad/phone by the workbench) can be added to the
    // home screen and keeps working through Wi-Fi blips. autoUpdate keeps it fresh after each deploy.
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.ico", "robots.txt", "icons/apple-touch-icon.png"],
      manifest: {
        name: "Tool Vision — garage tool inventory",
        short_name: "Tool Vision",
        description: "Label, sort, and find every tool in your garage — hands-free.",
        theme_color: "#1b1f27",
        background_color: "#1b1f27",
        display: "standalone",
        orientation: "portrait",
        start_url: "/",
        icons: [
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        // Cache the built shell for offline loads. The print connector and vision API are cross-origin
        // (localhost / the worker), so they're never cached here — those always hit the network live.
        globPatterns: ["**/*.{js,css,html,ico,png,svg,woff2}"],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith("/assets/"),
            handler: "StaleWhileRevalidate",
            options: { cacheName: "tv-assets" },
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    // Plain node env + a tiny localStorage shim, so importing the Supabase client in a unit test
    // doesn't require pulling jsdom into devDependencies.
    setupFiles: ["./vitest.setup.ts"],
  },
}));
