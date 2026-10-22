"use client";

import { m } from "motion/react";
import type { ReactNode } from "react";

export default function PageTransition({ children }: { children: ReactNode }) {
  return (
    <m.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
      {children}
    </m.div>
  );
}
