"use client";

import { useEffect, useRef, type HTMLAttributes } from "react";
import { fitOverlayToViewport } from "@/lib/visual-viewport";

export function SheetViewport(props: HTMLAttributes<HTMLDivElement>) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (ref.current) return fitOverlayToViewport(ref.current, window.visualViewport);
  }, []);

  return <div {...props} ref={ref} />;
}
