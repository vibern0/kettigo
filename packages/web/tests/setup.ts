import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

const listeners = new Set<(event: { matches: boolean }) => void>();
let reducedMotion = false;

export function setReducedMotion(value: boolean) {
  reducedMotion = value;
  listeners.forEach((listener) => listener({ matches: value }));
}

vi.stubGlobal("matchMedia", (query: string) => ({
  get matches() { return query.includes("prefers-reduced-motion") && reducedMotion; },
  media: query,
  addListener: (listener: (event: { matches: boolean }) => void) => listeners.add(listener),
  removeListener: (listener: (event: { matches: boolean }) => void) => listeners.delete(listener),
  addEventListener: (_event: string, listener: (event: { matches: boolean }) => void) => listeners.add(listener),
  removeEventListener: (_event: string, listener: (event: { matches: boolean }) => void) => listeners.delete(listener),
}));

afterEach(() => {
  cleanup();
  setReducedMotion(false);
  vi.clearAllMocks();
});
