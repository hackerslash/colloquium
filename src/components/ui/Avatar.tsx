import { useEffect } from "react";
import type { Presence } from "../../types/domain";
import { cx } from "../../lib/cx";
import { useAvatarStore } from "../../stores/useAvatarStore";

type AvatarProps = {
  id: string;
  name: string;
  size?: "xs" | "sm" | "md" | "xl";
  presence?: Presence;
  className?: string;
};

const SIZE: Record<NonNullable<AvatarProps["size"]>, { box: string; text: string; dot: string }> = {
  xs: { box: "h-5 w-5", text: "text-[9px]", dot: "h-1.5 w-1.5" },
  sm: { box: "h-6 w-6", text: "text-[10px]", dot: "h-2 w-2" },
  md: { box: "h-8 w-8", text: "text-xs", dot: "h-2.5 w-2.5" },
  xl: { box: "h-20 w-20", text: "text-2xl", dot: "h-5 w-5" },
};

const PALETTE = [
  "#5865f2",
  "#3ba55c",
  "#faa61a",
  "#ed4245",
  "#eb459e",
  "#9b59b6",
  "#3498db",
  "#e67e22",
];

const PRESENCE_DOT: Record<Presence, string> = {
  online: "bg-success",
  connecting: "bg-warning",
  offline: "bg-text-muted",
};

function initials(name: string): string {
  const words = name.trim().split(/\s+/);
  return words
    .slice(0, 2)
    .map((w) => w[0] ?? "")
    .join("")
    .toUpperCase();
}

function colorFor(id: string): string {
  let sum = 0;
  for (const ch of id) sum = (sum + ch.charCodeAt(0)) % PALETTE.length;
  return PALETTE[sum];
}

export function Avatar({ id, name, size = "md", presence, className }: AvatarProps) {
  const s = SIZE[size];
  const url = useAvatarStore((state) => state.urlById[id]);
  useEffect(() => {
    void useAvatarStore.getState().loadAvatar(id);
  }, [id]);

  return (
    <span className={cx("relative inline-flex shrink-0 transition-all", s.box, className)}>
      {url ? (
        <img
          src={url}
          alt=""
          className="h-full w-full rounded-full object-cover"
          draggable={false}
          aria-hidden="true"
        />
      ) : (
        <span
          className={cx(
            "flex h-full w-full items-center justify-center rounded-full font-semibold text-white",
            s.text,
          )}
          style={{ backgroundColor: colorFor(id) }}
          aria-hidden="true"
        >
          {initials(name)}
        </span>
      )}
      {presence && (
        <span
          className={cx(
            "absolute -bottom-0.5 -right-0.5 rounded-full ring-2 ring-bg-secondary",
            s.dot,
            PRESENCE_DOT[presence],
          )}
          aria-hidden="true"
        />
      )}
    </span>
  );
}
