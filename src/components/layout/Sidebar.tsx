import { useState } from "react";
import { Check, Copy, Hash, Home, Inbox, Plus, Settings, Volume2, X } from "lucide-react";
import { useRosterStore } from "../../stores/useRosterStore";
import { useRoomStore } from "../../stores/useRoomStore";
import { useIdentityStore } from "../../stores/useIdentityStore";
import { useFriendRequestStore } from "../../stores/useFriendRequestStore";
import { Avatar } from "../ui/Avatar";
import { UnreadBadge } from "../ui/Badge";
import { IconButton } from "../ui/IconButton";
import { cx } from "../../lib/cx";

export type Selection =
  | { kind: "home" }
  | { kind: "inbox" }
  | { kind: "dm"; contactId: string }
  | { kind: "group"; roomId: string };

type SidebarProps = {
  selection: Selection;
  onSelect: (selection: Selection) => void;
  onCreateGroup: () => void;
  onOpenSettings: () => void;
};

function shortId(identityId: string): string {
  return `${identityId.slice(0, 8)}…${identityId.slice(-4)}`;
}

export function Sidebar({ selection, onSelect, onCreateGroup, onOpenSettings }: SidebarProps) {
  const self = useIdentityStore((s) => s.self);
  const contactsById = useRosterStore((s) => s.contactsById);
  const presenceById = useRosterStore((s) => s.presenceById);
  const dmRoomIdByContact = useRosterStore((s) => s.dmRoomIdByContact);
  const removeContact = useRosterStore((s) => s.removeContact);
  const roomsById = useRoomStore((s) => s.roomsById);
  const callParticipantsByRoom = useRoomStore((s) => s.callParticipantsByRoom);
  const unreadByRoom = useRoomStore((s) => s.unreadByRoom);
  const pendingRequests = useFriendRequestStore((s) => s.pending.length);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const contacts = Object.values(contactsById).filter((c) => !c.revoked);
  const groupRooms = Object.values(roomsById).filter((r) => r.type === "group");

  function copyId() {
    if (!self) return;
    void navigator.clipboard.writeText(self.identityId).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1_500);
    });
  }

  return (
    <nav
      aria-label="Conversations"
      className="flex w-64 shrink-0 flex-col bg-bg-base"
    >
      <div className="flex h-16 shrink-0 items-center px-6">
        <span className="font-display italic text-xl font-normal tracking-[-0.02em] text-text-primary">
          Haven
        </span>
      </div>

      <div className="mx-4 mt-2">
        <button
          onClick={() => onSelect({ kind: "home" })}
          aria-current={selection.kind === "home" ? "true" : undefined}
          className={cx(
            "flex w-full items-center gap-3 rounded-[12px] px-3 py-2.5 text-left text-[14px] font-medium transition-all duration-200",
            selection.kind === "home"
              ? "bg-bg-primary text-text-primary shadow-sm"
              : "text-text-secondary hover:bg-bg-secondary hover:text-text-primary hover:-translate-y-0.5",
          )}
        >
          <Home size={18} aria-hidden="true" className={selection.kind === "home" ? "text-accent" : "text-text-muted"} />
          Home &amp; invites
        </button>
      </div>

      <div className="mx-4 mt-1">
        <button
          onClick={() => onSelect({ kind: "inbox" })}
          aria-current={selection.kind === "inbox" ? "true" : undefined}
          className={cx(
            "flex w-full items-center gap-3 rounded-[12px] px-3 py-2.5 text-left text-[14px] font-medium transition-all duration-200",
            selection.kind === "inbox"
              ? "bg-bg-primary text-text-primary shadow-sm"
              : "text-text-secondary hover:bg-bg-secondary hover:text-text-primary hover:-translate-y-0.5",
          )}
        >
          <Inbox size={18} aria-hidden="true" className={selection.kind === "inbox" ? "text-accent" : "text-text-muted"} />
          <span className="flex-1">Inbox</span>
          <UnreadBadge count={pendingRequests} />
        </button>
      </div>

      <div className="flex items-center justify-between px-6 pt-8 pb-3">
        <span className="text-[12px] font-semibold tracking-[0.05em] text-text-muted uppercase">
          Spaces
        </span>
        <IconButton icon={Plus} label="Create a room" size="sm" onClick={onCreateGroup} />
      </div>
      <ul className="px-4 space-y-1">
        {groupRooms.map((room) => {
          const active = selection.kind === "group" && selection.roomId === room.id;
          const inCall = callParticipantsByRoom[room.id]?.length ?? 0;
          const unread = unreadByRoom[room.id] ?? 0;
          return (
            <li key={room.id}>
              <button
                onClick={() => onSelect({ kind: "group", roomId: room.id })}
                aria-current={active ? "true" : undefined}
                className={cx(
                  "flex w-full items-center gap-3 rounded-[12px] px-3 py-2.5 text-left text-[14px] transition-all duration-200",
                  active
                    ? "bg-bg-primary font-medium text-text-primary shadow-sm"
                    : unread > 0
                      ? "font-semibold text-text-primary hover:bg-bg-secondary hover:-translate-y-0.5"
                      : "text-text-secondary hover:bg-bg-secondary hover:text-text-primary hover:-translate-y-0.5",
                )}
              >
                <Hash size={18} className={cx("shrink-0", active ? "text-accent" : "text-text-muted")} aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{room.name ?? "Room"}</span>
                {inCall > 0 && (
                  <span
                    className="flex shrink-0 items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-[11px] font-medium text-success"
                    title={`${inCall} in call`}
                  >
                    <Volume2 size={12} aria-hidden="true" />
                    {inCall}
                  </span>
                )}
                <UnreadBadge count={unread} />
              </button>
            </li>
          );
        })}
        {groupRooms.length === 0 && (
          <li className="px-3 py-2 text-[13px] text-text-muted">No spaces yet</li>
        )}
      </ul>

      <div className="px-6 pt-8 pb-3 text-[12px] font-semibold tracking-[0.05em] text-text-muted uppercase">
        Connections
      </div>
      <ul className="flex-1 overflow-y-auto px-4 space-y-1">
        {contacts.map((contact) => {
          const presence = presenceById[contact.identityId] ?? "offline";
          const active = selection.kind === "dm" && selection.contactId === contact.identityId;
          const roomId = dmRoomIdByContact[contact.identityId];
          const unread = roomId ? (unreadByRoom[roomId] ?? 0) : 0;
          return (
            <li key={contact.identityId} className="group relative">
              <button
                onClick={() => onSelect({ kind: "dm", contactId: contact.identityId })}
                aria-current={active ? "true" : undefined}
                className={cx(
                  "flex w-full items-center gap-3 rounded-[12px] px-3 py-2.5 pr-8 text-left transition-all duration-200",
                  active
                    ? "bg-bg-primary shadow-sm"
                    : "hover:bg-bg-secondary hover:text-text-primary hover:-translate-y-0.5",
                )}
              >
                <Avatar id={contact.identityId} name={contact.displayName} size="sm" presence={presence} />
                <span
                  className={cx(
                    "min-w-0 flex-1 truncate text-[14px]",
                    active || unread > 0 ? "font-medium text-text-primary" : "text-text-secondary",
                  )}
                >
                  {contact.displayName}
                </span>
                <UnreadBadge count={unread} />
              </button>
              {confirmingId === contact.identityId ? (
                <span className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1 bg-bg-primary p-1 rounded-lg shadow-sm z-10">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      void removeContact(contact.identityId);
                      setConfirmingId(null);
                    }}
                    aria-label={`Confirm remove ${contact.displayName}`}
                    className="rounded-md bg-danger px-2 py-1 text-[11px] font-bold text-white transition-colors hover:bg-danger-hover"
                  >
                    Remove
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setConfirmingId(null);
                    }}
                    aria-label="Cancel"
                    className="rounded-md p-1.5 text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
                  >
                    <X size={14} aria-hidden="true" />
                  </button>
                </span>
              ) : (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirmingId(contact.identityId);
                  }}
                  aria-label={`Remove ${contact.displayName}`}
                  title="Remove contact"
                  className="absolute right-3 top-1/2 hidden -translate-y-1/2 rounded-full bg-bg-primary p-1.5 text-text-muted shadow-sm hover:bg-danger hover:text-white group-hover:block transition-all"
                >
                  <X size={14} aria-hidden="true" />
                </button>
              )}
            </li>
          );
        })}
        {contacts.length === 0 && (
          <li className="px-3 py-2 text-[13px] leading-relaxed text-text-muted">
            No connections yet.
          </li>
        )}
      </ul>

      {/* User footer bar */}
      <div className="m-4 mt-2 flex shrink-0 items-center gap-3 rounded-[16px] bg-bg-secondary p-3 shadow-sm transition-colors hover:bg-bg-tertiary">
        {self && <Avatar id={self.identityId} name={self.displayName} size="md" />}
        <button
          onClick={copyId}
          title="Copy your ID"
          className="min-w-0 flex-1 text-left"
        >
          <span className="block truncate text-[14px] font-medium text-text-primary transition-colors hover:text-accent">
            {self?.displayName}
          </span>
          <span className="flex items-center gap-1 font-mono text-[11px] text-text-muted mt-0.5">
            {self ? shortId(self.identityId) : null}
            {copied ? <Check size={12} aria-hidden="true" className="text-success" /> : <Copy size={12} aria-hidden="true" />}
          </span>
        </button>
        <IconButton icon={Settings} label="Settings" onClick={onOpenSettings} />
      </div>
    </nav>
  );
}
