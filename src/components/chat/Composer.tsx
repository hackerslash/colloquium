import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Bold, Code, Italic, Paperclip, Pencil, Quote, Reply, SendHorizontal, Smile, Strikethrough, Plus, X } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { IconButton } from "../ui/IconButton";
import { MAX_FILE_SIZE } from "../../services/room/chatService";
import { toast } from "../../stores/useToastStore";
import { EmojiPicker } from "./EmojiPicker";
import { MentionAutocomplete, type MentionCandidate } from "./MentionAutocomplete";

type ComposerProps = {
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
  onSend: (file?: File) => void | Promise<unknown>;
  replyingTo?: { id: string; authorName: string; snippet: string } | null;
  onCancelReply?: () => void;
  /** When set, the composer is editing an existing message: shows an edit
   * banner, hides the attach button, and Escape cancels. */
  editing?: boolean;
  onCancelEdit?: () => void;
  /** Members mentionable in this room (excludes self). Enables @-autocomplete. */
  mentionCandidates?: MentionCandidate[];
};

const MAX_MENTION_MATCHES = 8;

/** Detects an in-progress `@query` immediately before the caret. Returns the
 * index of the `@` and the typed prefix, or null when the caret isn't in a
 * mention. Requires the `@` to be at line start or after whitespace so email
 * addresses and mid-word `@` don't trigger it. */
function detectMentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const m = /(?:^|\s)@([^\s@]{0,32})$/.exec(before);
  if (!m) return null;
  const query = m[1];
  return { start: caret - query.length - 1, query };
}

/** Lets a parent (the drag-and-drop zone around the whole chat window) hand
 * a dropped file to the composer as if it had been picked via the file input. */
export type ComposerHandle = {
  acceptFile: (file: File) => void;
};

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  { value, placeholder, onChange, onSend, replyingTo, onCancelReply, editing, onCancelEdit, mentionCandidates },
  ref,
) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [sending, setSending] = useState(false);
  const [mentionQuery, setMentionQuery] = useState<{ start: number; query: string } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);

  const mentionMatches =
    mentionQuery && mentionCandidates
      ? mentionCandidates
          .filter((c) => c.name.toLowerCase().includes(mentionQuery.query.toLowerCase()))
          .slice(0, MAX_MENTION_MATCHES)
      : [];
  const mentionOpen = mentionMatches.length > 0;
  const activeMention = Math.min(mentionIndex, mentionMatches.length - 1);

  const acceptFile = useCallback((file: File) => {
    if (file.size > MAX_FILE_SIZE) {
      toast.error(
        "File too large",
        `Attachments are limited to ${Math.round(MAX_FILE_SIZE / (1024 * 1024))} MB.`,
      );
      return;
    }
    setSelectedFile(file);
  }, []);

  useImperativeHandle(ref, () => ({ acceptFile }), [acceptFile]);

  function autoGrow() {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }

  useEffect(() => {
    autoGrow();
  }, [value]);

  // Picking "Reply" on a message should hand focus straight to the input —
  // keyed on the message id (not the replyingTo object, which both callers
  // rebuild every render) so this only fires when the target actually changes.
  const replyId = replyingTo?.id;
  useEffect(() => {
    if (replyId) textareaRef.current?.focus();
  }, [replyId]);

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    onChange(e.target.value);
    autoGrow();
    const detected = mentionCandidates
      ? detectMentionQuery(e.target.value, e.target.selectionStart ?? e.target.value.length)
      : null;
    setMentionQuery(detected);
    setMentionIndex(0);
  }

  function selectMention(candidate: MentionCandidate) {
    if (!mentionQuery) return;
    const end = mentionQuery.start + 1 + mentionQuery.query.length;
    // Insert the readable `@Name ` — the authoritative @[Name](id) token is
    // reconstructed from room members at send time (encodeMentions), so the
    // input never shows the raw id.
    replaceRange(mentionQuery.start, end, `@${candidate.name} `);
    setMentionQuery(null);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Mention dropdown consumes navigation keys before send/cancel-reply.
    if (mentionOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionIndex((i) => (i + 1) % mentionMatches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIndex((i) => (i - 1 + mentionMatches.length) % mentionMatches.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        selectMention(mentionMatches[activeMention]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMentionQuery(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
    if (e.key === "Escape") {
      if (editing) onCancelEdit?.();
      else if (replyingTo) onCancelReply?.();
    }
  }

  function handleSend() {
    if (sending) return;
    if (!value.trim() && !selectedFile) return;
    const result = onSend(selectedFile ?? undefined);
    setSelectedFile(null);
    setShowEmojiPicker(false);
    if (result) {
      setSending(true);
      void Promise.resolve(result).finally(() => setSending(false));
    }
  }

  function insertTextAtCursor(textToInsert: string) {
    const el = textareaRef.current;
    if (!el) {
      onChange(value + textToInsert);
      return;
    }
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    const newValue = value.substring(0, start) + textToInsert + value.substring(end);
    onChange(newValue);

    setTimeout(() => {
      el.focus();
      const newPos = start + textToInsert.length;
      el.setSelectionRange(newPos, newPos);
      autoGrow();
    }, 0);
  }

  /** Replaces the text in [start, end) with `textToInsert` and drops the caret
   * after it. Used to swap a typed `@query` for a full mention token. */
  function replaceRange(start: number, end: number, textToInsert: string) {
    const el = textareaRef.current;
    const newValue = value.substring(0, start) + textToInsert + value.substring(end);
    onChange(newValue);
    setTimeout(() => {
      if (!el) return;
      el.focus();
      const pos = start + textToInsert.length;
      el.setSelectionRange(pos, pos);
      autoGrow();
    }, 0);
  }

  function wrapFormatting(prefix: string, suffix = prefix) {
    const el = textareaRef.current;
    if (!el) return;
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    const selectedText = value.substring(start, end);
    const textToInsert = `${prefix}${selectedText || "text"}${suffix}`;
    const newValue = value.substring(0, start) + textToInsert + value.substring(end);
    onChange(newValue);

    setTimeout(() => {
      el.focus();
      if (selectedText) {
        el.setSelectionRange(start + prefix.length, end + prefix.length);
      } else {
        el.setSelectionRange(start + prefix.length, start + prefix.length + 4);
      }
      autoGrow();
    }, 0);
  }

  return (
    <div className="relative px-4 pb-4 pt-1">
      {/* Reply Banner */}
      <AnimatePresence>
        {replyingTo && (
          <motion.div
            initial={{ opacity: 0, y: 10, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.95 }}
            className="mb-2.5 flex items-center gap-2 rounded-xl bg-bg-elevated px-4 py-2 text-sm text-text-primary shadow-md border border-border/60"
          >
            <Reply size={16} className="shrink-0 text-accent" />
            <span className="shrink-0 text-xs text-text-muted">Replying to</span>
            <span className="shrink-0 font-medium">{replyingTo.authorName}</span>
            <span className="flex-1 truncate text-xs text-text-muted">{replyingTo.snippet}</span>
            <button
              onClick={onCancelReply}
              aria-label="Cancel reply"
              className="rounded-full bg-black/10 p-1 text-text-muted transition-colors hover:bg-danger/20 hover:text-danger"
            >
              <X size={14} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Edit Banner */}
      <AnimatePresence>
        {editing && (
          <motion.div
            initial={{ opacity: 0, y: 10, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.95 }}
            className="mb-2.5 flex items-center gap-2 rounded-xl bg-warning/10 px-4 py-2 text-sm text-text-primary shadow-md border border-warning/40"
          >
            <Pencil size={16} className="shrink-0 text-warning" />
            <span className="flex-1 text-xs text-text-muted">Editing message · Esc to cancel</span>
            <button
              onClick={onCancelEdit}
              aria-label="Cancel edit"
              className="rounded-full bg-black/10 p-1 text-text-muted transition-colors hover:bg-danger/20 hover:text-danger"
            >
              <X size={14} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* File Attachment Badge */}
      <AnimatePresence>
        {selectedFile && (
          <motion.div
            initial={{ opacity: 0, y: 10, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.95 }}
            className="mb-2.5 flex items-center gap-2 rounded-xl bg-bg-elevated px-4 py-2 text-sm text-text-primary shadow-md border border-border/60"
          >
            <Paperclip size={16} className="text-text-muted" />
            <span className="flex-1 truncate font-medium">{selectedFile.name}</span>
            <button
              onClick={() => setSelectedFile(null)}
              className="rounded-full bg-black/10 p-1 text-text-muted transition-colors hover:bg-danger/20 hover:text-danger"
            >
              <X size={14} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Emoji Picker Popover */}
      <AnimatePresence>
        {showEmojiPicker && (
          <EmojiPicker
            onSelectEmoji={(emoji) => {
              insertTextAtCursor(emoji);
            }}
            onClose={() => setShowEmojiPicker(false)}
          />
        )}
      </AnimatePresence>

      {/* Mention Autocomplete Popover */}
      <AnimatePresence>
        {mentionOpen && (
          <MentionAutocomplete
            candidates={mentionMatches}
            activeIndex={activeMention}
            onSelect={selectMention}
            onHover={setMentionIndex}
          />
        )}
      </AnimatePresence>

      {/* Discord Style Full Width Input Container */}
      <div className="relative flex w-full flex-col rounded-xl border border-border/50 bg-bg-tertiary/90 transition-colors focus-within:border-accent/60 focus-within:ring-1 focus-within:ring-accent/40 shadow-sm">
        {/* Input Row */}
        <div className="flex w-full items-end gap-1.5 px-3 py-1.5">
          <input
            type="file"
            ref={fileInputRef}
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) acceptFile(file);
              if (fileInputRef.current) fileInputRef.current.value = "";
            }}
          />

          {/* Plus / Attach Button (hidden while editing — edits are text-only) */}
          {!editing && (
            <button
              type="button"
              title="Attach file"
              onClick={() => fileInputRef.current?.click()}
              className="mb-1.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white/5 text-text-muted hover:bg-accent hover:text-white transition-colors"
            >
              <Plus size={16} />
            </button>
          )}

          {/* Text Area */}
          <textarea
            ref={textareaRef}
            value={value}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            rows={1}
            placeholder={placeholder}
            aria-label="Message"
            className="max-h-44 min-h-[38px] flex-1 resize-none border-0 bg-transparent px-2 py-2 text-sm text-text-primary outline-none focus:outline-none focus:ring-0 focus:border-0 shadow-none placeholder:text-text-muted leading-relaxed select-text"
          />

          {/* Actions: Emoji Picker & Send */}
          <div className="mb-1 flex items-center gap-1 shrink-0">
            {/* Markdown Quick Toolbar */}
            <div className="hidden sm:flex items-center gap-0.5 border-r border-border/40 pr-1.5 mr-0.5">
              <button
                type="button"
                onClick={() => wrapFormatting("**")}
                title="Bold (**text**)"
                className="rounded p-1 text-text-muted hover:bg-bg-elevated hover:text-text-primary transition-colors"
              >
                <Bold size={14} />
              </button>
              <button
                type="button"
                onClick={() => wrapFormatting("*")}
                title="Italic (*text*)"
                className="rounded p-1 text-text-muted hover:bg-bg-elevated hover:text-text-primary transition-colors"
              >
                <Italic size={14} />
              </button>
              <button
                type="button"
                onClick={() => wrapFormatting("~~")}
                title="Strikethrough (~~text~~)"
                className="rounded p-1 text-text-muted hover:bg-bg-elevated hover:text-text-primary transition-colors"
              >
                <Strikethrough size={14} />
              </button>
              <button
                type="button"
                onClick={() => wrapFormatting("`")}
                title="Code (`code`)"
                className="rounded p-1 text-text-muted hover:bg-bg-elevated hover:text-text-primary transition-colors"
              >
                <Code size={14} />
              </button>
              <button
                type="button"
                onClick={() => wrapFormatting("> ", "")}
                title="Quote (> text)"
                className="rounded p-1 text-text-muted hover:bg-bg-elevated hover:text-text-primary transition-colors"
              >
                <Quote size={14} />
              </button>
            </div>

            {/* Emoji Picker Toggle Button */}
            <button
              type="button"
              title="Add emoji"
              onClick={() => setShowEmojiPicker((v) => !v)}
              className={`rounded-lg p-1.5 transition-colors ${
                showEmojiPicker
                  ? "bg-accent/20 text-accent"
                  : "text-text-muted hover:bg-bg-elevated hover:text-text-primary"
              }`}
            >
              <Smile size={18} />
            </button>

            {/* Send Button */}
            <IconButton
              icon={SendHorizontal}
              label="Send message"
              size="sm"
              variant={value.trim() || selectedFile ? "accent" : "ghost"}
              disabled={sending || (!value.trim() && !selectedFile)}
              tooltip={false}
              onClick={handleSend}
            />
          </div>
        </div>
      </div>
    </div>
  );
});
