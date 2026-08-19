import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // During local dev the worker runs on :8787; proxy API + auth requests.
    proxy: {
      "/api": "http://localhost:8787",
      "/v1": "http://localhost:8787",
      "/chat": "http://localhost:8787",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});