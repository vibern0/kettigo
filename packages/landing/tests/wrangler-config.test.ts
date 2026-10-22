import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("landing Worker configuration", () => {
  it("keeps the repository-root Cloudflare config aligned with the landing Worker", () => {
    const rootConfig = readFileSync("../../wrangler.toml", "utf8");

    expect(rootConfig).toContain('name = "kettigo-landing"');
    expect(rootConfig).toContain('main = "packages/landing/worker/index.ts"');
    expect(rootConfig).toContain('compatibility_date = "2026-09-25"');
    expect(rootConfig).toContain("workers_dev = true");
    expect(rootConfig).toContain('routes = [{ pattern = "kettigo.xyz", custom_domain = true }]');
    expect(rootConfig).toContain("[observability]\nenabled = true");
    expect(rootConfig).toContain('directory = "packages/landing/dist"');
    expect(rootConfig).toContain('binding = "ASSETS"');
    expect(rootConfig).toContain('run_worker_first = ["/api/*"]');
    expect(rootConfig).toContain('not_found_handling = "single-page-application"');
    expect(rootConfig).toContain("crons = []");
    expect(rootConfig.match(/binding = "DB"/g)).toHaveLength(2);
    expect(rootConfig.match(/database_name = "kettigo"/g)).toHaveLength(2);
    expect(
      rootConfig.match(/database_id = "d6cfede8-60bb-45dc-b342-60e6da48f1e4"/g),
    ).toHaveLength(2);
    expect(rootConfig.match(/migrations_dir = "packages\/landing\/migrations"/g)).toHaveLength(2);
    expect(rootConfig).toContain("[previews]\n\n[[previews.d1_databases]]");
    expect(rootConfig).not.toContain("packages/web");
  });

  it("builds the landing package for repository-root Cloudflare builds", () => {
    const rootPackage = JSON.parse(readFileSync("../../package.json", "utf8")) as {
      scripts?: { "cf:build"?: string };
    };

    expect(rootPackage.scripts?.["cf:build"]).toBe("pnpm --filter @kettigo/landing build");
  });

  it("binds shared D1 and explicitly removes inherited Cron Triggers", () => {
    const config = JSON.parse(
      readFileSync(join(process.cwd(), "wrangler.jsonc"), "utf8").replace(/\/\/.*$/gm, ""),
    ) as {
      triggers?: { crons?: string[] };
      d1_databases?: Array<{ database_name?: string; database_id?: string }>;
      previews?: { d1_databases?: Array<{ database_name?: string; database_id?: string }> };
    };

    expect(config.triggers?.crons).toEqual([]);
    expect(config.d1_databases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          database_name: "kettigo",
          database_id: "d6cfede8-60bb-45dc-b342-60e6da48f1e4",
        }),
      ]),
    );
    expect(config.previews?.d1_databases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          database_name: "kettigo",
          database_id: "d6cfede8-60bb-45dc-b342-60e6da48f1e4",
        }),
      ]),
    );
  });

  it("applies trigger changes after uploading the Worker", () => {
    const packageJson = JSON.parse(
      readFileSync(join(process.cwd(), "package.json"), "utf8"),
    ) as { scripts?: { deploy?: string } };

    expect(packageJson.scripts?.deploy).toContain("wrangler deploy");
    expect(packageJson.scripts?.deploy).toContain("wrangler triggers deploy");
  });
});
