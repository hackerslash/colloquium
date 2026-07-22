import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { AlertCircle, Check, CheckCheck, Clock, Download, MessageSquare, Paperclip, Pencil, Reply, SmilePlus, Trash2, X } from "lucide-react";
import type { DeliveryStatus, Message, Reaction } from "../../types/domain";
import { useChatStore } from "../../stores/useChatStore";
import { useIdentityStore } from "../../stores/useIdentityStore";
import { useRosterStore } from "../../stores/useRosterStore";
import { useRoomStore } from "../../stores/useRoomStore";
import { Avatar } from "../ui/Avatar";
import { EmptyState } from "../ui/EmptyState";
import { Skeleton } from "../ui/Skeleton";
import { EmojiPicker } from "./EmojiPicker";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { humanizeMentions } from "../../lib/mentions";
import {
  ANIMATED_EMOJI,
  humanizeAnimatedEmoji,
  jumboAnimatedEmojiIds,
  resolveAnimatedEmojiUrl,
  resolveEmoji,
} from "../../lib/animatedEmoji";
import { cx } from "../../lib/cx";
import * as fileRepo from "../../services/db/fileRepo";

const GROUP_GAP_MS = 5 * 60_000;

function timeOf(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function daySeparatorLabel(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (sameDay(d, today)) return "Today";
  if (sameDay(d, yesterday)) return "Yesterday";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function DeliveryTick({ status, readAt }: { status: DeliveryStatus; readAt: number | null }) {
  if (readAt) {
    return <CheckCheck size={12} className="text-accent" aria-label="Read" />;
  }
  switch (status) {
    case "pending":
      return <Clock size={12} className="text-text-muted" aria-label="Sending" />;
    case "sent":
      return <Check size={12} className="text-text-muted" aria-label="Sent" />;
    case "delivered":
      return <CheckCheck size={12} className="text-text-muted" aria-label="Delivered" />;
    case "failed":
      return <AlertCircle size={12} className="text-danger" aria-label="Failed to send" />;
  }
}

function MessageAttachment({ message, isOwn }: { message: Message; isOwn: boolean }) {
  const isImage = message.attachmentType?.startsWith("image/") || message.contentType === "image";
  const [url, setUrl] = useState<string | null>(null);
  const [available, setAvailable] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!message.attachmentId) return;

    let cancelled = false;
    let objectUrl: string | null = null;

    function checkFile() {
      const id = message.attachmentId!;
      if (isImage) {
        fileRepo.getFile(id).then((file) => {
          if (cancelled || !file) return;
          const blob = new Blob([file.data], { type: file.mimeType });
          if (objectUrl) URL.revokeObjectURL(objectUrl);
          objectUrl = URL.createObjectURL(blob);
          setUrl(objectUrl);
        });
      } else {
        fileRepo.fileExists(id).then((ok) => {
          if (!cancelled) setAvailable(ok);
        });
      }
    }

    checkFile();

    const handleFileEvent = (e: Event) => {
      const customEvent = e as CustomEvent<string>;
      if (customEvent.detail === message.attachmentId) {
        checkFile();
      }
    };

    window.addEventListener("colloquium_file_downloaded", handleFileEvent);

    return () => {
      cancelled = true;
      window.removeEventListener("colloquium_file_downloaded", handleFileEvent);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [message.attachmentId, message.attachmentType, message.contentType, isImage]);

  async function downloadFile() {
    if (!message.attachmentId) return;
    const file = await fileRepo.getFile(message.attachmentId);
    if (!file) return;
    const blob = new Blob([file.data], { type: file.mimeType });
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
  }

  useEffect(() => {
    if (!expanded) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [expanded]);

  if (url) {
    return (
      <>
        <div className="mt-1">
          <button type="button" onClick={() => setExpanded(true)} className="block cursor-zoom-in text-left">
            <img src={url} alt={message.attachmentName ?? "Attachment"} className="max-h-60 max-w-full rounded-md object-contain transition-opacity hover:opacity-90" />
          </button>
        </div>
        {createPortal(
          <AnimatePresence>
            {expanded && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
                className="fixed inset-0 z-[200] flex cursor-zoom-out items-center justify-center bg-black/80 p-8 backdrop-blur-sm"
                onClick={() => setExpanded(false)}
              >
                <motion.img
                  initial={{ scale: 0.95 }}
                  animate={{ scale: 1 }}
                  exit={{ scale: 0.95 }}
                  transition={{ type: "spring", damping: 25, stiffness: 300 }}
                  src={url}
                  alt={message.attachmentName ?? "Attachment"}
                  className="max-h-full max-w-full cursor-default rounded-md object-contain shadow-2xl"
                  onClick={(e) => e.stopPropagation()}
                />
                <button
                  type="button"
                  className="absolute right-4 top-4 rounded-full p-2 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
                  onClick={() => setExpanded(false)}
                  aria-label="Close"
                >
                  <X size={24} />
                </button>
              </motion.div>
            )}
          </AnimatePresence>,
          document.body
        )}
      </>
    );
  }

  return (
    <div className={cx("mt-1 flex items-center gap-2 rounded px-2 py-1 text-xs", isOwn ? "bg-black/20" : "bg-black/10")}>
      <Paperclip size={12} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate">{message.attachmentName}</span>
      {available && (
        <button
          type="button"
          onClick={() => void downloadFile()}
          aria-label={`Download ${message.attachmentName ?? "file"}`}
          title="Download"
          className={cx(
            "shrink-0 rounded p-0.5 transition-colors",
            isOwn ? "hover:bg-white/20" : "hover:bg-black/10",
          )}
        >
          <Download size={12} />
        </button>
      )}
    </div>
  );
}

const PICKER_W = 320;
const PICKER_H = 384;

function snippetOf(message: Message | undefined): string {
  if (!message) return "Original message unavailable";
  if (message.deletedAt) return "Message deleted";
  return message.body
    ? humanizeAnimatedEmoji(humanizeMentions(message.body))
    : message.attachmentName || "Attachment";
}

type MessageRowProps = {
  message: Message;
  isOwn: boolean;
  authorName: string;
  startsGroup: boolean;
  newDay: boolean;
  animateIn: boolean;
  selfId: string | undefined;
  reactions: Reaction[] | undefined;
  /** The message this one replies to, if it's loaded in this room. */
  replyToMessage: Message | undefined;
  nameOf: (id: string) => string;
  highlighted: boolean;
  /** Whether this row is the single currently-hovered message. */
  hovered: boolean;
  onToggleReaction: (messageId: string, emoji: string) => void;
  onReply: (message: Message) => void;
  onEdit: (message: Message) => void;
  onDelete: (messageId: string) => void;
  onQuoteClick: (messageId: string) => void;
};

const MessageRow = memo(function MessageRow({
  message,
  isOwn,
  authorName,
  startsGroup,
  newDay,
  animateIn,
  selfId,
  reactions,
  replyToMessage,
  nameOf,
  highlighted,
  hovered,
  onToggleReaction,
  onReply,
  onEdit,
  onDelete,
  onQuoteClick,
}: MessageRowProps) {
  const [pickerPos, setPickerPos] = useState<{ left: number; top: number } | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const deleted = message.deletedAt != null;
  const edited = message.editedAt != null && !deleted;
  // Sticker-style rendering: a message that's nothing but 1-3 animated emoji
  // (no other text, no attachment) drops the bubble entirely.
  const jumboIds =
    !deleted && !message.attachmentName ? jumboAnimatedEmojiIds(message.body) : null;

  function openPicker(e: React.MouseEvent<HTMLButtonElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const margin = 8;
    const left = Math.min(
      Math.max(margin, rect.left - PICKER_W / 2),
      window.innerWidth - PICKER_W - margin,
    );
    const top =
      rect.top - PICKER_H - margin >= margin
        ? rect.top - PICKER_H - margin
        : Math.min(rect.bottom + margin, window.innerHeight - PICKER_H - margin);
    setPickerPos({ left, top });
  }

  // Group reactions into pills: one per emoji, in first-reaction order.
  const pills: { emoji: string; count: number; mine: boolean; who: string }[] = [];
  if (reactions) {
    const byEmoji = new Map<string, Reaction[]>();
    for (const r of reactions) {
      const list = byEmoji.get(r.emoji);
      if (list) list.push(r);
      else byEmoji.set(r.emoji, [r]);
    }
    for (const [emoji, list] of byEmoji) {
      pills.push({
        emoji,
        count: list.length,
        mine: list.some((r) => r.authorId === selfId),
        who: list.map((r) => nameOf(r.authorId)).join(", "),
      });
    }
  }

  return (
    <li id={`msg-${message.id}`}>
      {newDay && (
        <div className="my-4 flex items-center gap-3">
          <span className="h-px flex-1 bg-border" />
          <span className="text-[11px] font-semibold text-text-muted">
            {daySeparatorLabel(message.sentAt)}
          </span>
          <span className="h-px flex-1 bg-border" />
        </div>
      )}
      <motion.div
        initial={animateIn ? { opacity: 0, y: 8 } : false}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 500, damping: 40 }}
        className={cx(
          "flex gap-2 rounded-lg transition-colors duration-500",
          startsGroup ? "mt-3" : "mt-0.5",
          isOwn ? "flex-row-reverse" : "flex-row",
          highlighted && "bg-accent/10",
        )}
      >
        {!isOwn &&
          (startsGroup ? (
            <Avatar id={message.authorId} name={authorName} size="md" />
          ) : (
            <span className="w-8 shrink-0" />
          ))}
        <div
          className={cx(
            "flex min-w-0 max-w-[75%] flex-col",
            isOwn ? "items-end" : "items-start",
          )}
        >
          {startsGroup && !isOwn && (
            <div className="mb-0.5 flex items-baseline gap-2">
              <span className="text-sm font-semibold text-text-primary">{authorName}</span>
              <span className="text-[11px] text-text-muted">{timeOf(message.sentAt)}</span>
            </div>
          )}
          {message.replyToId && !deleted && (
            <button
              type="button"
              onClick={() => replyToMessage && onQuoteClick(replyToMessage.id)}
              className={cx(
                "mb-0.5 flex max-w-full items-center gap-1.5 rounded-md border-l-2 border-accent/60 bg-bg-tertiary/60 px-2 py-1 text-left text-xs text-text-muted transition-colors",
                replyToMessage ? "hover:bg-bg-tertiary" : "cursor-default",
              )}
            >
              <Reply size={12} className="shrink-0" />
              {replyToMessage && (
                <span className="shrink-0 font-semibold text-text-secondary">
                  {nameOf(replyToMessage.authorId)}
                </span>
              )}
              <span className="truncate">{snippetOf(replyToMessage)}</span>
            </button>
          )}
          <div
            className={cx(
              "flex items-end gap-1.5",
              isOwn ? "flex-row-reverse" : "flex-row",
            )}
            data-message-id={message.id}
          >
            <div className="relative">
              {!deleted && (
                <div
                  className={cx(
                    "absolute -top-3 z-10 flex items-center gap-0.5 rounded-lg border border-border/60 bg-bg-elevated p-0.5 shadow-md transition-opacity",
                    isOwn ? "right-1" : "left-1",
                    hovered || pickerPos || confirmingDelete
                      ? "opacity-100"
                      : "pointer-events-none opacity-0",
                  )}
                >
                  <button
                    type="button"
                    title="Add reaction"
                    aria-label="Add reaction"
                    onClick={openPicker}
                    className="rounded p-1 hover:bg-bg-tertiary hover:text-text-primary transition-colors"
                  >
                    <SmilePlus size={14} />
                  </button>
                  <button
                    type="button"
                    title="Reply"
                    aria-label="Reply"
                    onClick={() => onReply(message)}
                    className="rounded p-1 hover:bg-bg-tertiary hover:text-text-primary transition-colors"
                  >
                    <Reply size={14} />
                  </button>
                  {isOwn && message.contentType === "text" && (
                    <button
                      type="button"
                      title="Edit"
                      aria-label="Edit"
                      onClick={() => onEdit(message)}
                      className="rounded p-1 hover:bg-bg-tertiary hover:text-text-primary transition-colors"
                    >
                      <Pencil size={14} />
                    </button>
                  )}
                  {isOwn &&
                    (confirmingDelete ? (
                      <>
                        <button
                          type="button"
                          title="Confirm delete"
                          aria-label="Confirm delete"
                          onClick={() => {
                            setConfirmingDelete(false);
                            onDelete(message.id);
                          }}
                          className="rounded p-1 text-danger hover:bg-danger/15 transition-colors"
                        >
                          <Check size={14} />
                        </button>
                        <button
                          type="button"
                          title="Cancel"
                          aria-label="Cancel delete"
                          onClick={() => setConfirmingDelete(false)}
                          className="rounded p-1 hover:bg-bg-tertiary hover:text-text-primary transition-colors"
                        >
                          <X size={14} />
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        title="Delete"
                        aria-label="Delete"
                        onClick={() => setConfirmingDelete(true)}
                        className="rounded p-1 hover:bg-danger/15 hover:text-danger transition-colors"
                      >
                        <Trash2 size={14} />
                      </button>
                    ))}
                </div>
              )}
              {jumboIds ? (
                // Emoji-only message (like a sticker): no bubble background,
                // just the animated emoji themselves, larger.
                <div className={cx("flex items-center gap-1 px-1 py-1", isOwn && "justify-end")}>
                  {jumboIds.map((id, i) => {
                    const url = resolveAnimatedEmojiUrl(id);
                    const def = ANIMATED_EMOJI.find((e) => e.id === id);
                    return url ? <img key={i} src={url} alt={def?.name ?? id} className="h-16 w-16" /> : null;
                  })}
                </div>
              ) : (
                <div
                  className={cx(
                    "select-text whitespace-pre-wrap wrap-anywhere px-3.5 py-2 text-sm shadow-sm transition-shadow hover:shadow-md",
                    deleted
                      ? "rounded-2xl border border-border/40 bg-bg-tertiary/40 italic text-text-muted"
                      : isOwn
                        ? "bg-gradient-to-br from-accent to-accent-hover text-white rounded-l-2xl rounded-tr-2xl rounded-br-sm"
                        : "bg-bg-elevated text-text-primary border border-border/50 rounded-r-2xl rounded-tl-sm rounded-bl-2xl",
                  )}
                >
                  {deleted ? (
                    "Message deleted"
                  ) : (
                    <>
                      {message.body && (
                        <MarkdownRenderer
                          content={message.body}
                          isOwn={isOwn}
                          resolveMention={nameOf}
                          selfId={selfId}
                        />
                      )}
                      {message.attachmentName && <MessageAttachment message={message} isOwn={isOwn} />}
                    </>
                  )}
                </div>
              )}
            </div>
            <span
              className={cx(
                "mb-0.5 flex shrink-0 items-center gap-1 text-[10px] text-text-muted",
                "transition-opacity",
                hovered || pickerPos || confirmingDelete ? "opacity-100" : "opacity-0",
              )}
            >
              {timeOf(message.sentAt)}
              {edited && (
                <span title={`Edited ${timeOf(message.editedAt!)}`}>(edited)</span>
              )}
              {isOwn && !deleted && (
                <DeliveryTick status={message.deliveryStatus} readAt={message.readAt} />
              )}
            </span>
          </div>
          {pills.length > 0 && !deleted && (
            <div className={cx("mt-1 flex flex-wrap gap-1", isOwn && "justify-end")}>
              {pills.map((pill) => (
                <button
                  key={pill.emoji}
                  type="button"
                  title={pill.who}
                  onClick={() => onToggleReaction(message.id, pill.emoji)}
                  className={cx(
                    "flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs transition-colors",
                    pill.mine
                      ? "border-accent/60 bg-accent/15 text-accent"
                      : "border-border/60 bg-bg-elevated text-text-secondary hover:border-border",
                  )}
                >
                  {(() => {
                    const resolved = resolveEmoji(pill.emoji);
                    return resolved.kind === "animated" ? (
                      <img src={resolved.url} alt={resolved.name} className="h-4 w-4" />
                    ) : (
                      <span>{resolved.glyph}</span>
                    );
                  })()}
                  <span className="font-semibold">{pill.count}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </motion.div>
      {pickerPos &&
        createPortal(
          <div className="fixed z-[100]" style={pickerPos}>
            <AnimatePresence>
              <EmojiPicker
                className="relative"
                onSelectEmoji={(emoji) => {
                  onToggleReaction(message.id, emoji);
                  setPickerPos(null);
                }}
                onClose={() => setPickerPos(null)}
              />
            </AnimatePresence>
          </div>,
          document.body,
        )}
    </li>
  );
});

type MessageListProps = {
  /** undefined = still loading; [] = loaded and empty. */
  messages: Message[] | undefined;
  roomId?: string;
  /** Current room members — recipients for reaction broadcasts. */
  memberIds?: string[];
  /** A message to scroll to and highlight (e.g. from search); cleared via
   * onJumpConsumed once the target is in the DOM. */
  jumpToMessageId?: string | null;
  onJumpConsumed?: () => void;
};

export function MessageList({
  messages,
  roomId,
  memberIds,
  jumpToMessageId,
  onJumpConsumed,
}: MessageListProps) {
  const self = useIdentityStore((s) => s.self);
  const contactsById = useRosterStore((s) => s.contactsById);
  const sessionState = useRoomStore((s) => (roomId ? s.roomSessionState[roomId] : undefined));
  const reactionsByMessage = useChatStore((s) => (roomId ? s.reactionsByRoom[roomId] : undefined));
  const toggleReaction = useChatStore((s) => s.toggleReaction);
  const setReplyingTo = useChatStore((s) => s.setReplyingTo);
  const beginEdit = useChatStore((s) => s.beginEdit);
  const deleteMessage = useChatStore((s) => s.deleteMessage);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  // Delegated on the container: every mouseover recomputes which message is
  // under the cursor, so a stale row self-corrects even if its own
  // mouseleave was dropped (Chromium misses it on fast moves/re-renders).
  const handleMouseOver = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const row = (e.target as HTMLElement).closest("[data-message-id]");
    setHoveredId(row ? row.getAttribute("data-message-id") : null);
  }, []);

  const bottomRef = useRef<HTMLDivElement>(null);
  const unreadBannerRef = useRef<HTMLLIElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const prevRoomIdRef = useRef<string | undefined>(undefined);
  const isStabilizingRef = useRef(false);
  const didInitialRender = useRef(false);
  const wasNearBottom = useRef(true);

  // Resolve the "New Messages" anchor once per room visit, then track it by
  // message id. Recomputing per render would let messages sent or received
  // while the chat is open grow the list and drag the banner onto them — it
  // must only mark what was unread when the room was opened.
  const unreadAnchorRef = useRef<{
    roomId: string | undefined;
    messageId: string | null;
    resolved: boolean;
  }>({ roomId: undefined, messageId: null, resolved: false });
  if (unreadAnchorRef.current.roomId !== roomId) {
    unreadAnchorRef.current = { roomId, messageId: null, resolved: false };
  }
  if (!unreadAnchorRef.current.resolved && messages && messages.length > 0) {
    const initialUnread = sessionState?.initialUnread ?? 0;
    const lastReadAt = sessionState?.lastReadAt ?? 0;
    let idx = -1;
    if (initialUnread > 0) {
      if (lastReadAt > 0) {
        idx = messages.findIndex(
          (m) => m.authorId !== self?.identityId && m.sentAt > lastReadAt,
        );
      }
      if (idx === -1) {
        idx = Math.max(0, messages.length - initialUnread);
      }
    }
    unreadAnchorRef.current = {
      roomId,
      messageId: idx >= 0 ? messages[idx].id : null,
      resolved: true,
    };
  }
  const anchorMessageId = unreadAnchorRef.current.messageId;
  const firstUnreadIndex =
    anchorMessageId && messages
      ? messages.findIndex((m) => m.id === anchorMessageId)
      : -1;

  // Detect room change
  useEffect(() => {
    if (roomId !== prevRoomIdRef.current) {
      prevRoomIdRef.current = roomId;
      isStabilizingRef.current = true;
      didInitialRender.current = false;
    }
  }, [roomId]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const onScroll = () => {
      wasNearBottom.current =
        container.scrollHeight - container.scrollTop - container.clientHeight < 120;
    };
    const onUserInteraction = () => {
      isStabilizingRef.current = false;
    };

    container.addEventListener("scroll", onScroll, { passive: true });
    container.addEventListener("wheel", onUserInteraction, { passive: true });
    container.addEventListener("touchmove", onUserInteraction, { passive: true });
    return () => {
      container.removeEventListener("scroll", onScroll);
      container.removeEventListener("wheel", onUserInteraction);
      container.removeEventListener("touchmove", onUserInteraction);
    };
  }, []);

  useEffect(() => {
    if (!messages || messages.length === 0) return;

    const container = containerRef.current;
    if (!container) return;

    const scrollToTarget = () => {
      if (unreadBannerRef.current) {
        unreadBannerRef.current.scrollIntoView({ block: "start" });
      } else if (bottomRef.current) {
        bottomRef.current.scrollIntoView({ block: "end" });
      }
    };

    if (isStabilizingRef.current || !didInitialRender.current) {
      didInitialRender.current = true;
      scrollToTarget();

      let animationFrameId: number;
      const startTime = performance.now();

      const stabilize = () => {
        if (!isStabilizingRef.current) return;
        scrollToTarget();
        if (performance.now() - startTime < 350) {
          animationFrameId = requestAnimationFrame(stabilize);
        } else {
          isStabilizingRef.current = false;
        }
      };

      animationFrameId = requestAnimationFrame(stabilize);

      const resizeObserver = new ResizeObserver(() => {
        if (isStabilizingRef.current) {
          scrollToTarget();
        }
      });
      resizeObserver.observe(container);

      return () => {
        cancelAnimationFrame(animationFrameId);
        resizeObserver.disconnect();
      };
    } else if (wasNearBottom.current) {
      bottomRef.current?.scrollIntoView({ block: "end" });
    }
  }, [messages, roomId]);

  const selfId = self?.identityId;
  const selfName = self?.displayName;
  const nameOf = useCallback(
    (authorId: string): string => {
      if (authorId === selfId) return selfName ?? "You";
      return contactsById[authorId]?.displayName ?? "Unknown";
    },
    [selfId, selfName, contactsById],
  );

  const messageById = useMemo(() => {
    const map = new Map<string, Message>();
    for (const m of messages ?? []) map.set(m.id, m);
    return map;
  }, [messages]);

  const handleToggleReaction = useCallback(
    (messageId: string, emoji: string) => {
      if (!roomId) return;
      void toggleReaction(roomId, memberIds ?? [], messageId, emoji);
    },
    [roomId, memberIds, toggleReaction],
  );

  const handleReply = useCallback(
    (message: Message) => {
      if (roomId) setReplyingTo(roomId, message);
    },
    [roomId, setReplyingTo],
  );

  const handleEdit = useCallback(
    (message: Message) => {
      if (roomId) beginEdit(roomId, message);
    },
    [roomId, beginEdit],
  );

  const handleDelete = useCallback(
    (messageId: string) => {
      if (roomId) void deleteMessage(roomId, memberIds ?? [], messageId);
    },
    [roomId, memberIds, deleteMessage],
  );

  const handleQuoteClick = useCallback((messageId: string) => {
    document
      .getElementById(`msg-${messageId}`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
    setHighlightId(messageId);
    window.setTimeout(
      () => setHighlightId((cur) => (cur === messageId ? null : cur)),
      1500,
    );
  }, []);

  // Jump-to-message (from search): once the target row is in the DOM, stop the
  // room-open scroll stabilizer from fighting us, then scroll + highlight it.
  useEffect(() => {
    if (!jumpToMessageId) return;
    if (!document.getElementById(`msg-${jumpToMessageId}`)) return;
    isStabilizingRef.current = false;
    handleQuoteClick(jumpToMessageId);
    onJumpConsumed?.();
  }, [messages, jumpToMessageId, handleQuoteClick, onJumpConsumed]);

  if (messages === undefined) {
    return (
      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex gap-3">
            <Skeleton className="h-8 w-8 rounded-full" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-3 w-32" />
              <Skeleton className="h-3 w-3/4" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div className="flex flex-1 flex-col overflow-y-auto">
        <EmptyState
          icon={MessageSquare}
          title="No messages yet"
          description="Say hello — messages are end-to-end between trusted devices."
        />
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="flex-1 overflow-y-auto px-4 py-4"
      role="log"
      onMouseOver={handleMouseOver}
      onMouseLeave={() => setHoveredId(null)}
    >
      <ul>
        {messages.map((message, i) => {
          const prev = messages[i - 1];
          const isOwn = message.authorId === self?.identityId;
          const newDay =
            !prev || new Date(prev.sentAt).toDateString() !== new Date(message.sentAt).toDateString();
          const startsGroup =
            newDay ||
            !prev ||
            prev.authorId !== message.authorId ||
            message.sentAt - prev.sentAt > GROUP_GAP_MS;

          const isFirstUnread = i === firstUnreadIndex;

          return (
            <Fragment key={message.id}>
              {isFirstUnread && (
                <li ref={unreadBannerRef} className="my-4 flex items-center gap-3">
                  <span className="h-px flex-1 bg-accent/40" />
                  <span className="rounded-full bg-accent/15 px-3 py-1 text-xs font-semibold text-accent shadow-sm">
                    New Messages
                  </span>
                  <span className="h-px flex-1 bg-accent/40" />
                </li>
              )}
              <MessageRow
                message={message}
                isOwn={isOwn}
                authorName={nameOf(message.authorId)}
                startsGroup={startsGroup}
                newDay={newDay}
                animateIn={didInitialRender.current}
                selfId={selfId}
                reactions={reactionsByMessage?.[message.id]}
                replyToMessage={
                  message.replyToId ? messageById.get(message.replyToId) : undefined
                }
                nameOf={nameOf}
                highlighted={highlightId === message.id}
                hovered={hoveredId === message.id}
                onToggleReaction={handleToggleReaction}
                onReply={handleReply}
                onEdit={handleEdit}
                onDelete={handleDelete}
                onQuoteClick={handleQuoteClick}
              />
            </Fragment>
          );
        })}
      </ul>
      <div ref={bottomRef} />
    </div>
  );
}
