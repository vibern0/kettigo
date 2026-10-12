import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const landingReadme = join(process.cwd(), "README.md");
const rootReadme = join(process.cwd(), "../../README.md");

function read(path: string): string {
  return readFileSync(path, "utf8");
}

describe("landing operations README", () => {
  it("documents the local operator command flow", () => {
    const markdown = read(landingReadme);

    expect(markdown).toContain("npm install");
    expect(markdown).toContain("npm run landing:dev");
    expect(markdown).toContain("npm run landing:typecheck");
    expect(markdown).toContain("npm run landing:test");
    expect(markdown).toContain("npm run landing:build");
    expect(markdown).toContain("npm run landing:deploy");
    expect(markdown).toContain(
      "npm exec --workspace @kettigo/landing wrangler d1 migrations apply kettigo-landing-local --local",
    );
    expect(markdown).toContain("UPDATE waitlist_entries SET approved_at = datetime('now')");
  });

  it("documents production deployment, smoke tests, and rollback", () => {
    const markdown = read(landingReadme);

    expect(markdown).toContain("wrangler d1 info kettigo");
    expect(markdown).toContain("d6cfede8-60bb-45dc-b342-60e6da48f1e4");
    expect(markdown).not.toContain("wrangler d1 create kettigo");
    expect(markdown).not.toContain("00000000-0000-0000-0000-000000000000");
    expect(markdown).toContain(
      "npm exec --workspace @kettigo/landing wrangler d1 migrations apply kettigo --remote",
    );
    expect(markdown).toContain("Approve remote emails with a targeted D1 update");
    expect(markdown).toContain("Waitlist join");
    expect(markdown).toContain("Manual approval");
    expect(markdown).toContain("Reuse prevention");
    expect(markdown).toContain("replay");
    expect(markdown).toContain("previous Worker version");
    expect(markdown).toContain("dropping waitlist data is not a safe rollback");
  });

  it("links from the root README and documents root deployment ownership", () => {
    expect(read(rootReadme)).toContain("[Landing site operations](packages/landing/README.md)");
    expect(read(landingReadme)).toContain(
      "The root\n`wrangler.toml` and `cf:build` script target the landing Worker",
    );
    expect(read(landingReadme)).toContain("packages/web/wrangler.jsonc");
  });
});
