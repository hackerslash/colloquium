import { useRef } from "react";
import { SendHorizontal } from "lucide-react";
import { IconButton } from "../ui/IconButton";

type ComposerProps = {
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
  onSend: () => void;
};

export function Composer({ value, placeholder, onChange, onSend }: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  function autoGrow() {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    onChange(e.target.value);
    autoGrow();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSend();
      // Reset height after send clears the value.
      requestAnimationFrame(() => {
        if (textareaRef.current) textareaRef.current.style.height = "auto";
      });
    }
  }

  return (
    <div className="px-4 pb-4 pt-2">
      <div className="flex items-end gap-2 rounded-xl border border-border-strong bg-bg-tertiary px-3 py-2 focus-within:border-accent">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          rows={1}
          placeholder={placeholder}
          aria-label="Message"
          className="max-h-40 flex-1 resize-none border-none bg-transparent text-sm text-text-primary outline-none placeholder:text-text-muted"
        />
        <IconButton
          icon={SendHorizontal}
          label="Send"
          size="sm"
          variant={value.trim() ? "accent" : "ghost"}
          disabled={!value.trim()}
          tooltip={false}
          onClick={onSend}
        />
      </div>
    </div>
  );
}
