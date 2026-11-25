import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations(new URL("./migrations", import.meta.url).pathname);
const requireFromConfig = createRequire(import.meta.url);
const requireFromVitest = createRequire(requireFromConfig.resolve("vitest/package.json"));
const vitestWorkerPackages = ["expect", "mocker", "pretty-format", "runner", "snapshot", "spy", "utils"].map(
  (name) => `@vitest/${name}`,
);
const vitestWorkerAliases = vitestWorkerPackages.flatMap((packageName) => {
    const name = packageName.replace("@vitest/", "");
    const packageRoot = dirname(requireFromVitest.resolve(`@vitest/${name}/package.json`));
    return [
      { find: new RegExp(`^@vitest/${name}/(.+)$`), replacement: `${packageRoot}/dist/$1.js` },
      { find: new RegExp(`^@vitest/${name}$`), replacement: `${packageRoot}/dist/index.js` },
    ];
  },
);

export default defineConfig({
  define: {
    __D1_MIGRATIONS__: JSON.stringify(migrations),
  },
  resolve: {
    alias: vitestWorkerAliases,
  },
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  test: {
    include: [
      "tests/**/*.worker.test.ts",
      "tests/**/*-worker.test.ts",
      "tests/worker-routing.test.ts",
      "tests/security-privacy.test.ts",
      "tests/validation.test.ts",
      "tests/turnstile.test.ts",
    ],
    passWithNoTests: true,
    deps: {
      optimizer: {
        ssr: {
          enabled: true,
          include: vitestWorkerPackages,
        },
      },
    },
    setupFiles: ["tests/worker.setup.ts"],
  },
});
