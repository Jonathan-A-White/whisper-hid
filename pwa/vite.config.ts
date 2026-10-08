import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { execSync } from "child_process";
import { buildVersion } from "./src/lib/buildVersion";

function gitVersion(): string {
  try {
    const count = execSync("git rev-list --count HEAD").toString().trim();
    const hash = execSync("git rev-parse --short HEAD").toString().trim();
    return buildVersion(`1.0.${count}+${hash}`, new Date());
  } catch {
    return buildVersion("1.0.0-dev", new Date());
  }
}

export default defineConfig({
  base: "/whisper-hid/",
  define: {
    __APP_VERSION__: JSON.stringify(gitVersion()),
  },
  plugins: [
    react(),
    VitePWA({
      // 'prompt': a new build waits until he taps the Update banner (src/lib/appUpdate.ts).
      registerType: 'prompt',
      manifest: {
        name: "Whisper Keyboard",
        short_name: "Whisper",
        start_url: "/whisper-hid/",
        display: "fullscreen",
        background_color: "#000000",
        theme_color: "#000000",
        icons: [
          {
            src: "icon-192.png",
            sizes: "192x192",
            type: "image/png",
          },
          {
            src: "icon-512.png",
            sizes: "512x512",
            type: "image/png",
          },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,woff2,png,svg}"],
        clientsClaim: true,
      },
    }),
  ],
});
