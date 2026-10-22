import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "../src/App";

describe("landing shell", () => {
  it("renders one main region and an open app link", () => {
    render(<App />);
    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /open kettigo/i })[0]).toHaveAttribute(
      "href",
      "https://app.kettigo.xyz/",
    );
    expect(document.querySelector("#waitlist")).toBeNull();
  });
});
