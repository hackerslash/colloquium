import { useEffect, useRef } from "react";
import { motion } from "motion/react";
import type { Message } from "../../types/domain";
import { useIdentityStore } from "../../stores/useIdentityStore";
import { useRosterStore } from "../../stores/useRosterStore";

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    day: "numeric",
  });
}

type MessageListProps = {
  messages: Message[];
};

export function MessageList({ messages }: MessageListProps) {
  const self = useIdentityStore((s) => s.self);
  const contactsById = useRosterStore((s) => s.contactsById);
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to the newest message only when the user is already near the
  // bottom, so reading history isn't yanked away by an incoming message.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const nearBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight < 120;
    if (nearBottom) bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  function authorName(authorId: string): string {
    if (authorId === self?.identityId) return self.displayName;
    return contactsById[authorId]?.displayName ?? "Unknown";
  }

  return (
    <div ref={containerRef} className="flex-1 overflow-y-auto px-4 py-4" role="log">
      {messages.length === 0 && (
        <p className="mt-8 text-center text-sm text-text-secondary">
          No messages yet. Say hello.
        </p>
      )}
      <ul className="space-y-3">
        {messages.map((message) => (
          <motion.li
            key={message.id}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ type: "spring", stiffness: 500, damping: 40 }}
            className="flex flex-col"
          >
            <div className="flex items-baseline gap-2">
              <span className="text-sm font-semibold">{authorName(message.authorId)}</span>
              <span className="text-xs text-text-secondary">{formatTime(message.sentAt)}</span>
            </div>
            <p className="whitespace-pre-wrap break-words text-sm text-text-primary">
              {message.body}
            </p>
          </motion.li>
        ))}
      </ul>
      <div ref={bottomRef} />
    </div>
  );
}
