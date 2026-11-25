import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // Preserve import.meta.url so the SDK's adjacent WASM files resolve in dev.
  optimizeDeps: { exclude: ["@zama-fhe/relayer-sdk"] },
  server: { port: 3001, strictPort: true },
});
