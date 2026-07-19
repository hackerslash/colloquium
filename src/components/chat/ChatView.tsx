import { useEffect, useState } from "react";
import { Bell, BellOff, Phone, Video } from "lucide-react";
import { useIdentityStore } from "../../stores/useIdentityStore";
import { useRosterStore } from "../../stores/useRosterStore";
import { useChatStore } from "../../stores/useChatStore";
import { useRoomStore } from "../../stores/useRoomStore";
import { useCallStore } from "../../stores/useCallStore";
import { dmRoomId } from "../../services/room/chatService";
import { MessageList } from "./MessageList";
import { Composer } from "./Composer";
import { TypingIndicator } from "./TypingIndicator";
import { notifyTyping, stopTyping } from "../../services/room/typingService";
import { Avatar } from "../ui/Avatar";
import { IconButton } from "../ui/IconButton";
import { EmptyState } from "../ui/EmptyState";
import { UserX } from "lucide-react";
import type { Presence } from "../../types/domain";
import { toast } from "../../stores/useToastStore";
import { formatLastSeen } from "../../lib/time";

const PRESENCE_LABEL: Record<Presence, string> = {
  online: "Online",
  connecting: "Connecting…",
  offline: "Offline",
};

type ChatViewProps = {
  contactId: string;
};

export function ChatView({ contactId }: ChatViewProps) {
  const self = useIdentityStore((s) => s.self);
  const contact = useRosterStore((s) => s.contactsById[contactId]);
  const presence = useRosterStore((s) => s.presenceById[contactId]) ?? "offline";

  const loadMessages = useChatStore((s) => s.loadMessages);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const setDraft = useChatStore((s) => s.setDraft);
  const setActiveRoom = useRoomStore((s) => s.setActiveRoom);
  const toggleMute = useRoomStore((s) => s.toggleMute);
  const startCall = useCallStore((s) => s.startCall);
  const callInProgress = useCallStore((s) => s.activeCall !== null);

  const [roomId, setRoomId] = useState<string | null>(null);
  const muted = useRoomStore((s) => (roomId ? !!s.mutedByRoom[roomId] : false));

  useEffect(() => {
    let cancelled = false;
    let myRoomId: string | null = null;
    if (!self) return;
    void dmRoomId(self.identityId, contactId).then((id) => {
      if (cancelled) return;
      myRoomId = id;
      setRoomId(id);
      setActiveRoom(id);
      void loadMessages(id);
    });
    return () => {
      cancelled = true;
      // Clear the active room so messages aren't silently marked read while the
      // user is elsewhere — but only if a newer view hasn't already claimed it
      // (the enter/exit crossfade can mount the next view before this unmounts).
      if (myRoomId && useRoomStore.getState().activeRoomId === myRoomId) {
        setActiveRoom(null);
      }
      if (myRoomId) stopTyping(myRoomId, [contactId]);
    };
  }, [self, contactId, loadMessages, setActiveRoom]);

  const messages = useChatStore((s) => (roomId ? s.messagesByRoom[roomId] : undefined));
  const draft = useChatStore((s) => (roomId ? s.draftByRoom[roomId] : undefined)) ?? "";
  const replyingTo = useChatStore((s) => (roomId ? s.replyingToByRoom[roomId] : null)) ?? null;
  const setReplyingTo = useChatStore((s) => s.setReplyingTo);

  // Re-render once a minute while offline so a "5m ago" label keeps advancing.
  const [, setTick] = useState(0);
  const offline = presence === "offline";
  useEffect(() => {
    if (!offline) return;
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, [offline]);

  function handleSend(file?: File) {
    if (!roomId) return;
    stopTyping(roomId, [contactId]);
    return sendMessage(roomId, [contactId], draft, file).catch((err) => {
      console.error("Failed to send message:", err);
      toast.error("Message not sent", "Please try again.");
    });
  }

  if (!contact) {
    return (
      <EmptyState icon={UserX} title="Contact not found" />
    );
  }

  const callDisabled = !roomId || callInProgress || presence !== "online";
  const callHint = presence !== "online" ? `${contact.displayName} is offline` : undefined;

  const statusLabel =
    offline && contact.lastSeenAt
      ? `Last seen ${formatLastSeen(contact.lastSeenAt)}`
      : PRESENCE_LABEL[presence];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
        <Avatar id={contactId} name={contact.displayName} size="sm" presence={presence} />
        <h1 className="text-sm font-semibold">{contact.displayName}</h1>
        <span className="text-xs text-text-secondary">{statusLabel}</span>
        <div className="ml-auto flex gap-1">
          <IconButton
            icon={muted ? BellOff : Bell}
            label={muted ? "Unmute notifications" : "Mute notifications"}
            active={muted}
            disabled={!roomId}
            onClick={() => roomId && toggleMute(roomId)}
          />
          <IconButton
            icon={Phone}
            label={callHint ?? "Start voice call"}
            disabled={callDisabled}
            onClick={() => roomId && startCall(roomId, contactId, false)}
          />
          <IconButton
            icon={Video}
            label={callHint ?? "Start video call"}
            disabled={callDisabled}
            onClick={() => roomId && startCall(roomId, contactId, true)}
          />
        </div>
      </header>
      <MessageList messages={messages} roomId={roomId ?? undefined} memberIds={[contactId]} />
      <TypingIndicator roomId={roomId} />
      <Composer
        value={draft}
        placeholder={`Message ${contact.displayName}`}
        replyingTo={
          replyingTo && {
            authorName:
              replyingTo.authorId === self?.identityId
                ? self.displayName
                : contact.displayName,
            snippet: replyingTo.body || replyingTo.attachmentName || "Attachment",
          }
        }
        onCancelReply={() => roomId && setReplyingTo(roomId, null)}
        onChange={(v) => {
          if (!roomId) return;
          setDraft(roomId, v);
          if (v) notifyTyping(roomId, [contactId]);
          else stopTyping(roomId, [contactId]);
        }}
        onSend={handleSend}
      />
    </div>
  );
}
