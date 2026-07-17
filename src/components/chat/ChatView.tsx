import { useEffect, useState } from "react";
import { Phone, Video } from "lucide-react";
import { useIdentityStore } from "../../stores/useIdentityStore";
import { useRosterStore } from "../../stores/useRosterStore";
import { useChatStore } from "../../stores/useChatStore";
import { useRoomStore } from "../../stores/useRoomStore";
import { useCallStore } from "../../stores/useCallStore";
import { dmRoomId } from "../../services/room/chatService";
import { MessageList } from "./MessageList";
import { Composer } from "./Composer";
import { Avatar } from "../ui/Avatar";
import { IconButton } from "../ui/IconButton";
import { EmptyState } from "../ui/EmptyState";
import { UserX } from "lucide-react";
import type { Presence } from "../../types/domain";
import { toast } from "../../stores/useToastStore";

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
  const startCall = useCallStore((s) => s.startCall);
  const callInProgress = useCallStore((s) => s.activeCall !== null);

  const [roomId, setRoomId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!self) return;
    void dmRoomId(self.identityId, contactId).then((id) => {
      if (cancelled) return;
      setRoomId(id);
      setActiveRoom(id);
      void loadMessages(id);
    });
    return () => {
      cancelled = true;
    };
  }, [self, contactId, loadMessages, setActiveRoom]);

  const messages = useChatStore((s) => (roomId ? s.messagesByRoom[roomId] : undefined));
  const draft = useChatStore((s) => (roomId ? s.draftByRoom[roomId] : undefined)) ?? "";

  function handleSend(file?: File) {
    if (!roomId) return;
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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
        <Avatar id={contactId} name={contact.displayName} size="sm" presence={presence} />
        <h1 className="text-sm font-semibold">{contact.displayName}</h1>
        <span className="text-xs text-text-secondary">{PRESENCE_LABEL[presence]}</span>
        <div className="ml-auto flex gap-1">
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
      <MessageList messages={messages} />
      <Composer
        value={draft}
        placeholder={`Message ${contact.displayName}`}
        onChange={(v) => roomId && setDraft(roomId, v)}
        onSend={handleSend}
      />
    </div>
  );
}
