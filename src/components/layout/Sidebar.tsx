import { useState } from "react";
import { Check, Copy, Hash, Home, Plus, Settings, Volume2, X } from "lucide-react";
import { useRosterStore } from "../../stores/useRosterStore";
import { useRoomStore } from "../../stores/useRoomStore";
import { useIdentityStore } from "../../stores/useIdentityStore";
import { Avatar } from "../ui/Avatar";
import { UnreadBadge } from "../ui/Badge";
import { IconButton } from "../ui/IconButton";
import { cx } from "../../lib/cx";

export type Selection =
  | { kind: "home" }
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
      className="flex w-64 shrink-0 flex-col border-r border-border bg-bg-secondary"
    >
      <div className="flex h-12 shrink-0 items-center border-b border-border px-4">
        <span className="text-sm font-semibold tracking-tight text-text-primary">Haven</span>
      </div>

      <button
        onClick={() => onSelect({ kind: "home" })}
        aria-current={selection.kind === "home" ? "true" : undefined}
        className={cx(
          "mx-2 mt-2 flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
          selection.kind === "home"
            ? "bg-bg-elevated text-text-primary"
            : "text-text-secondary hover:bg-bg-tertiary hover:text-text-primary",
        )}
      >
        <Home size={16} aria-hidden="true" />
        Home &amp; invites
      </button>

      <div className="flex items-center justify-between px-3 pt-4 pb-1">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
          Rooms
        </span>
        <IconButton icon={Plus} label="Create a room" size="sm" onClick={onCreateGroup} />
      </div>
      <ul className="px-2">
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
                  "flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                  active
                    ? "bg-bg-elevated text-text-primary"
                    : unread > 0
                      ? "font-medium text-text-primary hover:bg-bg-tertiary"
                      : "text-text-secondary hover:bg-bg-tertiary hover:text-text-primary",
                )}
              >
                <Hash size={16} className="shrink-0 text-text-muted" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{room.name ?? "Room"}</span>
                {inCall > 0 && (
                  <span
                    className="flex shrink-0 items-center gap-0.5 text-xs font-medium text-success"
                    title={`${inCall} in call`}
                  >
                    <Volume2 size={13} aria-hidden="true" />
                    {inCall}
                  </span>
                )}
                <UnreadBadge count={unread} />
              </button>
            </li>
          );
        })}
        {groupRooms.length === 0 && (
          <li className="px-2 py-1 text-xs text-text-muted">No rooms yet</li>
        )}
      </ul>

      <div className="px-3 pt-4 pb-1 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
        Direct Messages
      </div>
      <ul className="flex-1 overflow-y-auto px-2">
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
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 pr-8 text-left transition-colors",
                  active
                    ? "bg-bg-elevated"
                    : unread > 0
                      ? "hover:bg-bg-tertiary"
                      : "hover:bg-bg-tertiary",
                )}
              >
                <Avatar id={contact.identityId} name={contact.displayName} size="sm" presence={presence} />
                <span
                  className={cx(
                    "min-w-0 flex-1 truncate text-sm",
                    active || unread > 0 ? "font-medium text-text-primary" : "text-text-secondary",
                  )}
                >
                  {contact.displayName}
                </span>
                <UnreadBadge count={unread} />
              </button>
              {confirmingId === contact.identityId ? (
                <span className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-1">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      void removeContact(contact.identityId);
                      setConfirmingId(null);
                    }}
                    aria-label={`Confirm remove ${contact.displayName}`}
                    className="rounded bg-danger px-1.5 py-0.5 text-xs text-white"
                  >
                    Remove
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setConfirmingId(null);
                    }}
                    aria-label="Cancel"
                    className="rounded p-0.5 text-text-secondary hover:text-text-primary"
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
                  className="absolute right-1.5 top-1/2 hidden -translate-y-1/2 rounded p-1 text-text-muted hover:bg-danger hover:text-white group-hover:block"
                >
                  <X size={14} aria-hidden="true" />
                </button>
              )}
            </li>
          );
        })}
        {contacts.length === 0 && (
          <li className="px-2 py-1 text-xs text-text-muted">
            No contacts yet — invite someone from Home.
          </li>
        )}
      </ul>

      {/* User footer bar */}
      <div className="flex h-[52px] shrink-0 items-center gap-2 border-t border-border bg-bg-base px-2">
        {self && <Avatar id={self.identityId} name={self.displayName} size="md" />}
        <button
          onClick={copyId}
          title="Copy your ID"
          className="min-w-0 flex-1 text-left"
        >
          <span className="block truncate text-sm font-medium text-text-primary">
            {self?.displayName}
          </span>
          <span className="flex items-center gap-1 font-mono text-[11px] text-text-muted">
            {self ? shortId(self.identityId) : null}
            {copied ? <Check size={11} aria-hidden="true" /> : <Copy size={11} aria-hidden="true" />}
          </span>
        </button>
        <IconButton icon={Settings} label="Settings" onClick={onOpenSettings} />
      </div>
    </nav>
  );
}
