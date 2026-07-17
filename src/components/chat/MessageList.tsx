import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { AlertCircle, Check, CheckCheck, Clock, Download, MessageSquare, Paperclip, X } from "lucide-react";
import type { DeliveryStatus, Message } from "../../types/domain";
import { useIdentityStore } from "../../stores/useIdentityStore";
import { useRosterStore } from "../../stores/useRosterStore";
import { Avatar } from "../ui/Avatar";
import { EmptyState } from "../ui/EmptyState";
import { Skeleton } from "../ui/Skeleton";
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

function DeliveryTick({ status }: { status: DeliveryStatus }) {
  switch (status) {
    case "pending":
      return <Clock size={12} className="text-text-muted" aria-label="Sending" />;
    case "sent":
      return <Check size={12} className="text-text-muted" aria-label="Sent" />;
    case "delivered":
      return <CheckCheck size={12} className="text-accent" aria-label="Delivered" />;
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
          // Guard against resolving after unmount — otherwise we'd create an
          // object URL the cleanup has already run past and never revoke it.
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

    window.addEventListener("haven_file_downloaded", handleFileEvent);

    return () => {
      cancelled = true;
      window.removeEventListener("haven_file_downloaded", handleFileEvent);
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

  // Handle escape key to close lightbox
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
                className="fixed inset-0 z-[200] flex items-center justify-center bg-black/80 p-8 backdrop-blur-sm cursor-zoom-out"
                onClick={() => setExpanded(false)}
              >
                <motion.img
                  initial={{ scale: 0.95 }}
                  animate={{ scale: 1 }}
                  exit={{ scale: 0.95 }}
                  transition={{ type: "spring", damping: 25, stiffness: 300 }}
                  src={url}
                  alt={message.attachmentName ?? "Attachment"}
                  className="max-h-full max-w-full rounded-md object-contain shadow-2xl cursor-default"
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

type MessageListProps = {
  /** undefined = still loading; [] = loaded and empty. */
  messages: Message[] | undefined;
  /** Optional intro shown above the first message (e.g. DM header). */
  intro?: React.ReactNode;
};

export function MessageList({ messages, intro }: MessageListProps) {
  const self = useIdentityStore((s) => s.self);
  const contactsById = useRosterStore((s) => s.contactsById);
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const didInitialRender = useRef(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const nearBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight < 120;
    if (nearBottom || !didInitialRender.current) {
      bottomRef.current?.scrollIntoView({ block: "end" });
    }
    didInitialRender.current = true;
  }, [messages]);

  function authorName(authorId: string): string {
    if (authorId === self?.identityId) return self.displayName;
    return contactsById[authorId]?.displayName ?? "Unknown";
  }

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
        {intro}
        <EmptyState
          icon={MessageSquare}
          title="No messages yet"
          description="Say hello — messages are end-to-end between trusted devices."
        />
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex-1 overflow-y-auto px-4 py-4" role="log">
      {intro}
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

          return (
            <li key={message.id}>
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
                initial={didInitialRender.current ? { opacity: 0, y: 8 } : false}
                animate={{ opacity: 1, y: 0 }}
                transition={{ type: "spring", stiffness: 500, damping: 40 }}
                className={cx(
                  "flex gap-2",
                  startsGroup ? "mt-3" : "mt-0.5",
                  isOwn ? "flex-row-reverse" : "flex-row",
                )}
              >
                {/* Avatar column (others only); spacer keeps continuations aligned */}
                {!isOwn &&
                  (startsGroup ? (
                    <Avatar id={message.authorId} name={authorName(message.authorId)} size="md" />
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
                      <span className="text-sm font-semibold text-text-primary">
                        {authorName(message.authorId)}
                      </span>
                      <span className="text-[11px] text-text-muted">{timeOf(message.sentAt)}</span>
                    </div>
                  )}
                  <div
                    className={cx(
                      "group flex items-end gap-1.5",
                      isOwn ? "flex-row-reverse" : "flex-row",
                    )}
                  >
                    <div
                      className={cx(
                        "select-text whitespace-pre-wrap break-words px-3.5 py-2 text-sm shadow-sm transition-shadow hover:shadow-md",
                        isOwn
                          ? "bg-gradient-to-br from-accent to-accent-hover text-white rounded-l-2xl rounded-tr-2xl rounded-br-sm"
                          : "bg-bg-elevated text-text-primary border border-border/50 rounded-r-2xl rounded-tl-2xl rounded-bl-sm",
                      )}
                    >
                      {message.body && <div>{message.body}</div>}
                      {message.attachmentName && (
                        <MessageAttachment message={message} isOwn={isOwn} />
                      )}
                    </div>
                    <span
                      className={cx(
                        "mb-0.5 flex shrink-0 items-center gap-1 text-[10px] text-text-muted",
                        "opacity-0 transition-opacity group-hover:opacity-100",
                      )}
                    >
                      {timeOf(message.sentAt)}
                      {isOwn && <DeliveryTick status={message.deliveryStatus} />}
                    </span>
                  </div>
                </div>
              </motion.div>
            </li>
          );
        })}
      </ul>
      <div ref={bottomRef} />
    </div>
  );
}
