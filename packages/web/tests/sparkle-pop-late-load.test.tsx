import { act, fireEvent, render, screen } from "@testing-library/react";
import { LazyMotion, MotionConfig, domMax } from "motion/react";
import { expect, it, vi } from "vitest";
import { ToastProvider, useToast } from "../src/components/Toast";

const dependency = vi.hoisted(() => {
  let finishLoading!: () => void;
  const ready = new Promise<void>(resolve => { finishLoading = resolve; });
  return { ready, finishLoading, create: vi.fn(() => Object.assign(() => {}, { reset() {} })) };
});
vi.mock("canvas-confetti", async () => {
  await dependency.ready;
  return { default: { create: dependency.create } };
});

function Deposit() {
  const toast = useToast();
  return <button onClick={() => toast({ tone: "success", title: "Deposit complete.", celebration: "deposit" })}>Deposit</button>;
}

it("does not start a stale burst when particles finish loading after dismissal", async () => {
  const { container } = render(<MotionConfig reducedMotion="user"><LazyMotion features={domMax}>
    <ToastProvider><Deposit /></ToastProvider>
  </LazyMotion></MotionConfig>);
  fireEvent.click(screen.getByText("Deposit"));
  fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
  await act(async () => {
    dependency.finishLoading();
    await dependency.ready;
  });
  expect(container.querySelector("canvas")).toBeNull();
  expect(dependency.create).not.toHaveBeenCalled();
});
