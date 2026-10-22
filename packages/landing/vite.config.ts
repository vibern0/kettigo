import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

const DEFAULT_SITE_URL = "https://kettigo.xyz";

export function resolveSiteUrl(value = process.env.VITE_SITE_URL): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return DEFAULT_SITE_URL;
  }
  return trimmed.replace(/\/+$/, "");
}

export function renderLandingHtmlMetadata(html: string, value = process.env.VITE_SITE_URL): string {
  const siteUrl = resolveSiteUrl(value);
  return html.replaceAll("%SITE_URL%", siteUrl).replaceAll("%OG_IMAGE_URL%", `${siteUrl}/kettigo-share.png`);
}

function landingMetadataPlugin(): Plugin {
  return {
    name: "landing-metadata",
    transformIndexHtml(html) {
      return renderLandingHtmlMetadata(html);
    },
  };
}

export default defineConfig({
  plugins: [react(), landingMetadataPlugin()],
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    exclude: [
      "tests/**/*.worker.test.ts",
      "tests/**/*-worker.test.ts",
      "tests/worker-routing.test.ts",
      "tests/security-privacy.test.ts",
    ],
    setupFiles: ["@testing-library/jest-dom/vitest"],
  },
});
