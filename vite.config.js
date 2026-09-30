import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  // Local dev: the finance assistant runs on uvicorn (port 8000); proxying /api keeps it on
  // the same origin, exactly like the deployed app, where it's a Vercel function.
  // API_TARGET=https://<deployment> npm run dev sends /api to a deployment instead.
  server: {
    proxy: { "/api": { target: process.env.API_TARGET || "http://localhost:8000", changeOrigin: true } }
  },
  plugins: [
    VitePWA({
      registerType: "autoUpdate",
      workbox: {
        // The service worker answers page navigations with index.html; /api isn't the app.
        navigateFallbackDenylist: [/^\/api\//]
      },
      manifest: {
        name: "Ledger",
        short_name: "Ledger",
        description: "Shared family income & expenses",
        theme_color: "#16232E",
        background_color: "#EFEEE6",
        display: "standalone",
        start_url: "/",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" }
        ]
      }
    })
  ]
});
