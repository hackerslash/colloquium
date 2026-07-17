import type { ReactNode } from "react";

/** Floating control-bar shell shared by 1:1 and room calls. Fill it with
 * IconButton (size="lg") controls: mic, camera, present, leave. */
export function CallControlBar({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-border bg-bg-base/90 px-4 py-3 shadow-modal backdrop-blur-md">
      {children}
    </div>
  );
}
