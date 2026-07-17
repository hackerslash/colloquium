import { cx } from "../../lib/cx";

export function Skeleton({ className }: { className?: string }) {
  return (
    <span
      className={cx(
        "block animate-pulse rounded-md bg-bg-tertiary motion-reduce:animate-none",
        className,
      )}
      aria-hidden="true"
    />
  );
}
