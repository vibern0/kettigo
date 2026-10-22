"use client";

import { useEffect, useRef } from "react";
import { useReducedMotion } from "motion/react";
import type { CreateTypes } from "canvas-confetti";

export type CelebrationKind = "deposit" | "prize";

// Each event owns its canvas, so a later celebration can safely replace it.
export function SparklePop({ kind }: { kind: CelebrationKind }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || reducedMotion) return;

    let cancelled = false;
    let burst: CreateTypes | undefined;
    const timers: number[] = [];
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const stop = () => {
      cancelled = true;
      timers.forEach(window.clearTimeout);
      burst?.reset();
    };
    const onPreferenceChange = () => {
      if (preference.matches) stop();
    };
    preference.addEventListener("change", onPreferenceChange);
    timers.push(window.setTimeout(stop, 2_000));

    // Keep the particle engine out of the initial app load.
    void import("canvas-confetti").then(({ default: confetti }) => {
      if (cancelled || preference.matches) return;

      burst = confetti.create(canvas, { resize: true, disableForReducedMotion: true });
      const options = {
        colors: ["#e4f66a", "#d5c5ff", "#ffb69d", "#2548f4"],
        shapes: ["star" as const, "circle" as const],
        origin: { x: 0.5, y: 0.18 },
        gravity: 0.8,
        decay: 0.91,
        ticks: 85,
        scalar: 0.85,
        disableForReducedMotion: true,
      };
      void burst({ ...options, particleCount: kind === "prize" ? 52 : 24, spread: 90, startVelocity: 22 });

      if (kind === "prize") {
        timers.push(window.setTimeout(() => {
          void burst?.({ ...options, particleCount: 24, spread: 135, startVelocity: 16 });
        }, 180));
      }
    }).catch(() => {
      // The readable success notification still works if particles cannot load.
    });

    return () => {
      stop();
      preference.removeEventListener("change", onPreferenceChange);
    };
  }, [kind, reducedMotion]);

  if (reducedMotion) return null;

  return <canvas ref={canvasRef} aria-hidden="true" className="pointer-events-none fixed inset-0 z-[45] h-full w-full" />;
}
