import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("landing Worker configuration", () => {
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
