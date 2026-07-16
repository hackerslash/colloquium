import { useState } from "react";
import { useRosterStore } from "../../stores/useRosterStore";
import { useRoomStore } from "../../stores/useRoomStore";
import type { Presence } from "../../types/domain";

const PRESENCE_DOT: Record<Presence, string> = {
  online: "bg-success",
  connecting: "bg-warning",
  offline: "bg-text-secondary",
};

const PRESENCE_LABEL: Record<Presence, string> = {
  online: "Online",
  connecting: "Connecting…",
  offline: "Offline",
};

export type Selection =
  | { kind: "home" }
  | { kind: "dm"; contactId: string }
  | { kind: "group"; roomId: string };

type SidebarProps = {
  selection: Selection;
  onSelect: (selection: Selection) => void;
  onCreateGroup: () => void;
};

export function Sidebar({ selection, onSelect, onCreateGroup }: SidebarProps) {
  const contactsById = useRosterStore((s) => s.contactsById);
  const presenceById = useRosterStore((s) => s.presenceById);
  const removeContact = useRosterStore((s) => s.removeContact);
  const roomsById = useRoomStore((s) => s.roomsById);
  // Inline confirm (window.confirm() is a no-op in the macOS webview).
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const contacts = Object.values(contactsById).filter((c) => !c.revoked);
  const groupRooms = Object.values(roomsById).filter((r) => r.type === "group");

  return (
    <nav
      aria-label="Conversations"
      className="flex w-64 shrink-0 flex-col border-r border-border bg-bg-secondary"
    >
      <button
        onClick={() => onSelect({ kind: "home" })}
        className={`m-2 rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors ${
          selection.kind === "home" ? "bg-bg-tertiary" : "hover:bg-bg-tertiary"
        }`}
      >
        Home &amp; invites
      </button>

      <div className="flex items-center justify-between px-3 pt-2 pb-1">
        <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
          Rooms — {groupRooms.length}
        </span>
        <button
          onClick={onCreateGroup}
          aria-label="Create a room"
          className="rounded px-1.5 text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
        >
          +
        </button>
      </div>
      <ul className="px-2">
        {groupRooms.map((room) => {
          const active = selection.kind === "group" && selection.roomId === room.id;
          return (
            <li key={room.id}>
              <button
                onClick={() => onSelect({ kind: "group", roomId: room.id })}
                aria-current={active ? "true" : undefined}
                className={`w-full truncate rounded-lg px-2 py-1.5 text-left text-sm transition-colors ${
                  active ? "bg-bg-tertiary" : "hover:bg-bg-tertiary"
                }`}
              >
                # {room.name ?? "Room"}
              </button>
            </li>
          );
        })}
      </ul>

      <div className="px-3 pt-3 pb-1 text-xs font-semibold uppercase tracking-wide text-text-secondary">
        Direct Messages — {contacts.length}
      </div>
      <ul className="flex-1 overflow-y-auto px-2">
        {contacts.map((contact) => {
          const presence = presenceById[contact.identityId] ?? "offline";
          const active = selection.kind === "dm" && selection.contactId === contact.identityId;
          return (
            <li key={contact.identityId} className="group relative">
              <button
                onClick={() => onSelect({ kind: "dm", contactId: contact.identityId })}
                aria-current={active ? "true" : undefined}
                className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 pr-8 text-left transition-colors ${
                  active ? "bg-bg-tertiary" : "hover:bg-bg-tertiary"
                }`}
              >
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${PRESENCE_DOT[presence]}`}
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{contact.displayName}</span>
                  <span className="block text-xs text-text-secondary">
                    {PRESENCE_LABEL[presence]}
                  </span>
                </span>
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
                    title="Remove"
                    className="rounded bg-danger px-1.5 text-xs text-white"
                  >
                    Remove
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setConfirmingId(null);
                    }}
                    aria-label="Cancel"
                    title="Cancel"
                    className="rounded px-1 text-text-secondary hover:text-text-primary"
                  >
                    ✕
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
                  className="absolute right-1.5 top-1/2 hidden -translate-y-1/2 rounded px-1.5 text-text-secondary hover:bg-danger hover:text-white group-hover:block"
                >
                  ✕
                </button>
              )}
            </li>
          );
        })}
        {contacts.length === 0 && (
          <li className="px-2 py-1.5 text-sm text-text-secondary">No contacts yet.</li>
        )}
      </ul>
    </nav>
  );
}
