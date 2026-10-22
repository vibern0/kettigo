import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LazyMotion, MotionConfig, domMax } from "motion/react";
import { describe, expect, it, vi } from "vitest";
import { ToastProvider, useToast } from "../src/components/Toast";
import { setReducedMotion } from "./setup";

const confetti = vi.hoisted(() => {
  const emit = Object.assign(vi.fn<(options: Record<string, unknown>) => void>(), { reset: vi.fn() });
  return { emit, create: vi.fn(() => emit) };
});
vi.mock("canvas-confetti", () => ({ default: { create: confetti.create } }));

function Controls() {
  const toast = useToast();
  return <>
    <button onClick={() => toast({ tone: "success", title: "Deposit complete.", celebration: "deposit" })}>Deposit</button>
    <button onClick={() => toast({ tone: "success", title: "You got a prize!", celebration: "prize" })}>Prize</button>
    <button onClick={() => toast({ tone: "info", title: "No prize this time." })}>No prize</button>
    <button onClick={() => toast({ tone: "error", title: "Transaction failed", celebration: "deposit" })}>Failure</button>
  </>;
}

function mount() {
  return render(<MotionConfig reducedMotion="user"><LazyMotion features={domMax}>
    <ToastProvider><Controls /></ToastProvider>
  </LazyMotion></MotionConfig>);
}

describe("Sparkle Pop feedback", () => {
  it("celebrates a completed deposit and keeps its notification readable", async () => {
    const { container } = mount();
    fireEvent.click(screen.getByText("Deposit"));
    expect(screen.getByRole("status").textContent).toContain("Deposit complete.");
    await waitFor(() => expect(container.querySelector('canvas[aria-hidden="true"]')).not.toBeNull());
    await waitFor(() => expect(confetti.emit).toHaveBeenCalled());
    expect(confetti.emit.mock.calls[0][0].shapes).toContain("star");
  });

  it("does not celebrate zero winnings or failed transactions", () => {
    const { container } = mount();
    fireEvent.click(screen.getByText("No prize"));
    fireEvent.click(screen.getByText("Failure"));
    expect(container.querySelector("canvas")).toBeNull();
    expect(confetti.create).not.toHaveBeenCalled();
  });

  it("honors reduced motion while retaining the prize announcement", async () => {
    act(() => setReducedMotion(true));
    const { container } = mount();
    fireEvent.click(screen.getByText("Prize"));
    expect(screen.getByRole("status").textContent).toContain("You got a prize!");
    await act(async () => {});
    expect(confetti.create).not.toHaveBeenCalled();
    expect(container.querySelector("canvas")).toBeNull();
  });

  it("stops an active burst when reduced motion is enabled", async () => {
    mount();
    fireEvent.click(screen.getByText("Prize"));
    await waitFor(() => expect(confetti.emit).toHaveBeenCalled());
    act(() => setReducedMotion(true));
    expect(confetti.emit.reset).toHaveBeenCalled();
  });

  it("cleans up particles when the app unmounts", async () => {
    const { unmount } = mount();
    fireEvent.click(screen.getByText("Prize"));
    await waitFor(() => expect(confetti.emit).toHaveBeenCalled());
    unmount();
    expect(confetti.emit.reset).toHaveBeenCalled();
  });

  it("stops the celebration when its notification is dismissed", async () => {
    const { container } = mount();
    fireEvent.click(screen.getByText("Deposit"));
    await waitFor(() => expect(confetti.emit).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
    expect(container.querySelector("canvas")).toBeNull();
    expect(confetti.emit.reset).toHaveBeenCalled();
  });
});
