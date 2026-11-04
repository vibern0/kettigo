import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
const migrations = await readD1Migrations(new URL("./migrations", import.meta.url).pathname);
export default defineConfig({
  define: { __D1_MIGRATIONS__: JSON.stringify(migrations) },
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.test.jsonc" } })],
  test: { include: ["tests/**/*.test.ts"], setupFiles: ["tests/setup.ts"] },
});
