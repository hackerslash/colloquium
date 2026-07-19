import { motion } from "motion/react";
import { Avatar } from "../ui/Avatar";
import { cx } from "../../lib/cx";

export type MentionCandidate = { id: string; name: string };

type MentionAutocompleteProps = {
  candidates: MentionCandidate[];
  activeIndex: number;
  onSelect: (candidate: MentionCandidate) => void;
  onHover: (index: number) => void;
};

/** Dropdown of @-mention candidates, anchored above the composer. Keyboard
 * navigation (arrows/Enter/Tab/Esc) is driven by the Composer's keydown
 * handler — this is presentational: it renders the list and reports hover.
 * Rows use onMouseDown+preventDefault so clicking doesn't blur the textarea
 * before selection runs. */
export function MentionAutocomplete({
  candidates,
  activeIndex,
  onSelect,
  onHover,
}: MentionAutocompleteProps) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.97, y: 8 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97, y: 8 }}
      transition={{ duration: 0.12, ease: "easeOut" }}
      className="absolute bottom-16 left-4 z-50 max-h-64 w-64 overflow-y-auto rounded-2xl border border-border bg-bg-elevated/95 p-1 shadow-modal backdrop-blur-xl scrollbar-thin scrollbar-thumb-border"
      role="listbox"
    >
      {candidates.map((candidate, i) => (
        <button
          key={candidate.id}
          type="button"
          role="option"
          aria-selected={i === activeIndex}
          onMouseDown={(e) => {
            e.preventDefault();
            onSelect(candidate);
          }}
          onMouseEnter={() => onHover(i)}
          className={cx(
            "flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left text-sm transition-colors",
            i === activeIndex
              ? "bg-accent/20 text-text-primary"
              : "text-text-secondary hover:bg-bg-tertiary",
          )}
        >
          <Avatar id={candidate.id} name={candidate.name} size="xs" />
          <span className="min-w-0 flex-1 truncate">{candidate.name}</span>
        </button>
      ))}
    </motion.div>
  );
}
