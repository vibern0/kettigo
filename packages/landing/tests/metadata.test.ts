import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderLandingHtmlMetadata, resolveSiteUrl } from "../vite.config";

describe("landing metadata", () => {
  it("renders the production page with the shared social metadata", () => {
    const source = readFileSync(resolve(process.cwd(), "index.html"), "utf8");
    const html = renderLandingHtmlMetadata(source, undefined);

    expect(html).toContain('href="https://kettigo.xyz"');
    expect(html).toContain('<title>Kettigo — Savings with a chance to win</title>');
    expect(html).toContain('content="Your savings, with weekly prizes. 100% of your principal, always."');
    expect(html).toContain('property="og:site_name" content="Kettigo"');
    expect(html).toContain('property="og:image" content="https://kettigo.xyz/kettigo-share.png"');
    expect(html).toContain('property="og:image:width" content="1734"');
    expect(html).toContain('property="og:image:height" content="907"');
    expect(html).toContain('property="og:image:alt" content="Kettigo — Save. Win. Keep it all."');
    expect(html).toContain('name="twitter:card" content="summary_large_image"');
    expect(html).toContain('name="twitter:image" content="https://kettigo.xyz/kettigo-share.png"');
  });

  it("ships the same thumbnail as the app", () => {
    const landingThumbnail = readFileSync(resolve(process.cwd(), "public/kettigo-share.png"));
    const appThumbnail = readFileSync(resolve(process.cwd(), "../web/public/kettigo-share.png"));

    expect(landingThumbnail).toEqual(appThumbnail);
  });

  it("normalizes configured preview URLs before HTML transform", () => {
    expect(resolveSiteUrl(" https://preview.example/ ")).toBe("https://preview.example");
  });
});
