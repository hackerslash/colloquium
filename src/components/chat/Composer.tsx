import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Bold, Code, Italic, Mic, Pause, Play, Paperclip, Pencil, Quote, Reply, SendHorizontal, Smile, Strikethrough, Plus, Trash2, X } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { IconButton } from "../ui/IconButton";
import { MAX_FILE_SIZE } from "../../services/room/chatService";
import { toast } from "../../stores/useToastStore";
import { EmojiPicker } from "./EmojiPicker";
import { MentionAutocomplete, type MentionCandidate } from "./MentionAutocomplete";
import { VoiceRecorder, getPreferredVoiceMimeType, MAX_VOICE_DURATION_MS, type VoiceCapture } from "../../services/room/voiceRecorder";

type ComposerProps = {
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
  onSend: (file?: File) => void | Promise<unknown>;
  onSendVoice?: (capture: VoiceCapture) => void | Promise<unknown>;
  replyingTo?: { id: string; authorName: string; snippet: string } | null;
  onCancelReply?: () => void;
  /** When set, the composer is editing an existing message: shows an edit
   * banner, hides the attach button, and Escape cancels. */
  editing?: boolean;
  onCancelEdit?: () => void;
  /** Members mentionable in this room (excludes self). Enables @-autocomplete. */
  mentionCandidates?: MentionCandidate[];
  onEditLast?: () => void;
  upload?: { name: string; pct: number } | null;
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

function formatMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

/** Lets a parent (the drag-and-drop zone around the whole chat window) hand
 * a dropped file to the composer as if it had been picked via the file input. */
export type ComposerHandle = {
  acceptFile: (file: File) => void;
};

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  {
    value,
    placeholder,
    onChange,
    onSend,
    onSendVoice,
    replyingTo,
    onCancelReply,
    editing,
    onCancelEdit,
    mentionCandidates,
    onEditLast,
    upload,
  },
  ref,
) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [sending, setSending] = useState(false);
  const [mentionQuery, setMentionQuery] = useState<{ start: number; query: string } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);

  const recorderRef = useRef<VoiceRecorder | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingMs, setRecordingMs] = useState(0);
  const [voicePreview, setVoicePreview] = useState<VoiceCapture | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewPlaying, setPreviewPlaying] = useState(false);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval>>(undefined);
  const voiceSupported = getPreferredVoiceMimeType() !== null;
  const canVoice = !!onSendVoice && !editing && !selectedFile && voiceSupported;

  useEffect(() => {
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
      recorderRef.current?.cancel();
      previewAudioRef.current?.pause();
    };
  }, []);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

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

  // Pasting a screenshot/image from the clipboard (Win+Shift+S, browser
  // "copy image", etc.) attaches it the same way the file picker or a
  // drag-and-drop would. Plain text paste is left untouched. Skipped while
  // editing since edits are text-only (the attach button is hidden too).
  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    if (editing) return;
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
      const file = item.getAsFile();
      if (!file) continue;
      e.preventDefault();
      const ext = item.type.split("/")[1] || "png";
      const named = new File([file], `clipboard-image-${Date.now()}.${ext}`, { type: item.type });
      acceptFile(named);
      return;
    }
  }

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
    if (e.key === "ArrowUp" && !value.trim() && !selectedFile && !editing && onEditLast) {
      e.preventDefault();
      onEditLast();
      return;
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

  async function startVoice() {
    if (isRecording || voicePreview) return;
    const rec = new VoiceRecorder();
    recorderRef.current = rec;
    try {
      await rec.start({
        onAutoStop: () => {
          void stopVoice();
        },
      });
      setIsRecording(true);
      setRecordingMs(0);
      tickRef.current = setInterval(() => {
        setRecordingMs(rec.durationMs);
        if (rec.durationMs >= MAX_VOICE_DURATION_MS) {
          void stopVoice();
        }
      }, 120);
    } catch (err) {
      recorderRef.current = null;
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("NotAllowed") || msg.includes("Permission")) {
        toast.error("Microphone blocked", "Allow mic access in System Settings and try again.");
      } else if (msg.includes("not supported")) {
        toast.error("Voice not supported", "This WebView cannot record audio.");
      } else {
        toast.error("Could not start recording", msg);
      }
    }
  }

  async function stopVoice() {
    const rec = recorderRef.current;
    if (!rec || rec !== recorderRef.current) return;
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = undefined;
    setIsRecording(false);
    try {
      const cap = await rec.stop();
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setVoicePreview(cap);
      setRecordingMs(cap.durationMs);
      setPreviewUrl(URL.createObjectURL(cap.blob));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("too short")) toast.error("Recording too short", "Hold to record at least 0.5s.");
      else toast.error("Recording failed", msg);
      setRecordingMs(0);
    } finally {
      if (recorderRef.current === rec) recorderRef.current = null;
    }
  }

  function cancelVoice() {
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = undefined;
    recorderRef.current?.cancel();
    recorderRef.current = null;
    setIsRecording(false);
    setRecordingMs(0);
    setVoicePreview(null);
    setPreviewPlaying(false);
    previewAudioRef.current?.pause();
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      setPreviewUrl(null);
    }
  }

  function togglePreviewPlay() {
    const audio = previewAudioRef.current;
    if (!audio) return;
    if (previewPlaying) {
      audio.pause();
      setPreviewPlaying(false);
    } else {
      void audio.play().then(() => setPreviewPlaying(true)).catch(() => {});
    }
  }

  async function sendVoice() {
    if (!voicePreview || !onSendVoice || sending) return;
    const cap = voicePreview;
    setSending(true);
    try {
      await onSendVoice(cap);
      cancelVoice();
    } catch (err) {
      toast.error("Failed to send voice message", err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
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

      {/* Upload Progress */}
      <AnimatePresence>
        {upload && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            className="mb-2.5 flex items-center gap-3 rounded-xl bg-bg-elevated px-4 py-2 text-sm shadow-md border border-border/60"
          >
            <Paperclip size={16} className="shrink-0 text-accent" />
            <span className="min-w-0 max-w-[40%] truncate text-xs text-text-secondary">
              {upload.name}
            </span>
            <div
              className="h-1.5 flex-1 overflow-hidden rounded-full bg-bg-tertiary"
              role="progressbar"
              aria-label="Sending attachment"
              aria-valuenow={upload.pct}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-150"
                style={{ width: `${upload.pct}%` }}
              />
            </div>
            <span className="shrink-0 text-xs font-medium tabular-nums text-text-muted">
              {upload.pct}%
            </span>
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

      {/* Voice Preview (after recording, before send) */}
      <AnimatePresence>
        {voicePreview && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            className="mb-2.5 flex items-center gap-3 rounded-xl bg-bg-elevated px-4 py-3 border border-border/60 shadow-md"
          >
            <button
              type="button"
              onClick={togglePreviewPlay}
              aria-label={previewPlaying ? "Pause preview" : "Play preview"}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-white hover:bg-accent/90 transition-colors"
            >
              {previewPlaying ? <Pause size={16} /> : <Play size={16} className="ml-0.5" />}
            </button>
            <div className="flex flex-1 items-center gap-[2px] h-6">
              {voicePreview.waveform.map((v, i) => (
                <span
                  key={i}
                  className="w-[3px] rounded-full bg-accent/70"
                  style={{ height: `${8 + v * 16}px` }}
                />
              ))}
            </div>
            <span className="shrink-0 text-xs font-medium tabular-nums text-text-muted">
              {formatMs(voicePreview.durationMs)}
            </span>
            <button
              type="button"
              onClick={cancelVoice}
              aria-label="Delete voice message"
              className="rounded-full bg-black/10 p-1.5 text-text-muted hover:bg-danger/20 hover:text-danger transition-colors"
            >
              <Trash2 size={16} />
            </button>
            <IconButton
              icon={SendHorizontal}
              label="Send voice message"
              size="sm"
              variant="accent"
              tooltip={false}
              onClick={sendVoice}
              disabled={sending}
            />
            <audio
              ref={previewAudioRef}
              src={previewUrl ?? undefined}
              onEnded={() => setPreviewPlaying(false)}
              onPause={() => setPreviewPlaying(false)}
              preload="metadata"
              className="hidden"
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Recording Indicator */}
      <AnimatePresence>
        {isRecording && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            className="mb-2.5 flex items-center gap-3 rounded-xl bg-danger/10 px-4 py-3 border border-danger/30 shadow-md"
          >
            <span className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-danger shadow-[0_0_8px_rgba(220,38,38,0.8)]" />
            <span className="text-xs font-medium tabular-nums text-danger">
              {formatMs(recordingMs)} / {formatMs(MAX_VOICE_DURATION_MS)}
            </span>
            <div className="flex flex-1 items-center justify-center gap-1">
              <span className="h-1 w-1 animate-bounce rounded-full bg-danger [animation-delay:0ms]" />
              <span className="h-1 w-1 animate-bounce rounded-full bg-danger [animation-delay:150ms]" />
              <span className="h-1 w-1 animate-bounce rounded-full bg-danger [animation-delay:300ms]" />
              <span className="ml-2 text-xs text-text-muted">Recording…</span>
            </div>
            <button
              type="button"
              onClick={cancelVoice}
              aria-label="Cancel recording"
              className="rounded-full bg-black/10 p-1.5 text-text-muted hover:bg-danger/20 hover:text-danger transition-colors"
            >
              <X size={16} />
            </button>
            <button
              type="button"
              onClick={stopVoice}
              aria-label="Stop recording"
              className="flex h-8 w-8 items-center justify-center rounded-full bg-danger text-white hover:bg-danger/90 transition-colors"
            >
              <Pause size={16} />
            </button>
          </motion.div>
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
          {!editing && !isRecording && !voicePreview && (
            <button
              type="button"
              title="Attach file"
              onClick={() => fileInputRef.current?.click()}
              className="mb-1.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white/5 text-text-muted hover:bg-accent hover:text-white transition-colors"
            >
              <Plus size={16} />
            </button>
          )}

          {/* Text Area (hidden while recording/previewing) */}
          {!isRecording && !voicePreview ? (
            <textarea
              ref={textareaRef}
              value={value}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              rows={1}
              placeholder={placeholder}
              aria-label="Message"
              className="max-h-44 min-h-[38px] flex-1 resize-none border-0 bg-transparent px-2 py-2 text-sm text-text-primary outline-none focus:outline-none focus:ring-0 focus:border-0 shadow-none placeholder:text-text-muted leading-relaxed select-text"
            />
          ) : (
            <div className="flex-1" aria-hidden />
          )}

          {/* Actions: Emoji Picker & Send / Voice */}
          <div className="mb-1 flex items-center gap-1 shrink-0">
            {!isRecording && !voicePreview ? (
              <>
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

                {/* Mic Button — only when composer empty and voice available */}
                {canVoice && !value.trim() && !selectedFile ? (
                  <button
                    type="button"
                    title="Record voice message"
                    aria-label="Record voice message"
                    onClick={startVoice}
                    className="rounded-full bg-white/5 p-1.5 text-text-muted hover:bg-accent hover:text-white transition-colors"
                  >
                    <Mic size={18} />
                  </button>
                ) : null}

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
              </>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
});
