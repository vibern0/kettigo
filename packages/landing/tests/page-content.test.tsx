import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "../src/App";

describe("marketing page", () => {
  it("uses the prize-first hierarchy and working CTA targets", () => {
    render(<App />);
    expect(screen.getByRole("heading", { level: 1, name: "Play for prizes. Keep your deposit." })).toBeInTheDocument();
    const links = screen.getAllByRole("link", { name: /open kettigo/i }) as HTMLAnchorElement[];
    expect(links.every((link) => link.href === "https://app.kettigo.xyz/")).toBe(true);
    expect(document.querySelector("#how-it-works")).not.toBeNull();
    expect(document.querySelector("#why-kettigo")).not.toBeNull();
  });

  it("does not publish fabricated or guaranteed claims", () => {
    render(<App />);
    const copy = document.body.textContent ?? "";
    expect(copy).not.toMatch(/APY|TVL|guaranteed|you won|current prize/i);
    expect(copy).not.toMatch(/testnet|Sepolia|prototype|faucet|mock|encrypted|decrypted|leakage/i);
  });
});
