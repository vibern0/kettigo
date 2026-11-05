import type { PoolScopeId } from "../../worker/selected-pool-scope";

type DocumentLocation = Readonly<{
  href: string;
  assign(href: string): void;
}>;

const BASE_ORIGIN = "https://kettigo.invalid";
const SAVINGS_ORIGIN = "https://kettigo.xyz";

/** Builds an internal link that retains the document's selected savings scope. */
export function scopeHref(input: string | URL, scopeId: PoolScopeId, currentHref?: string): string {
  const url = new URL(input, BASE_ORIGIN);
  if (currentHref) {
    const current = new URL(currentHref, BASE_ORIGIN);
    for (const [name, value] of current.searchParams) {
      if (name !== "savings" && !url.searchParams.has(name)) url.searchParams.append(name, value);
    }
  }
  url.searchParams.set("savings", scopeId);
  return `${url.pathname}${url.search}${url.hash}`;
}

/** Switches savings scope by replacing the entire document, never client route state. */
export function switchDocumentScope(scopeId: PoolScopeId, location: DocumentLocation): void {
  location.assign(scopeHref(location.href, scopeId));
}

export function isAlternateSavingsOrigin(origin: string): boolean {
  return origin !== SAVINGS_ORIGIN;
}
