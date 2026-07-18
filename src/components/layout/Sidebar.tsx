import { useEffect, useRef, useState } from "react";
import {
  Check,
  Copy,
  Hash,
  Home,
  Inbox,
  Mic,
  MicOff,
  Plus,
  Settings,
  Video,
  Volume2,
  X,
} from "lucide-react";
import { useRosterStore } from "../../stores/useRosterStore";
import { useRoomStore } from "../../stores/useRoomStore";
import { useRoomCallStore } from "../../stores/useRoomCallStore";
import { useIdentityStore } from "../../stores/useIdentityStore";
import { useFriendRequestStore } from "../../stores/useFriendRequestStore";
import * as roomMembersRepo from "../../services/db/roomMembersRepo";
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

export function Sidebar({
  selection,
  onSelect,
  onCreateGroup,
  onOpenSettings,
}: SidebarProps) {
  const self = useIdentityStore((s) => s.self);
  const contactsById = useRosterStore((s) => s.contactsById);
  const presenceById = useRosterStore((s) => s.presenceById);
  const dmRoomIdByContact = useRosterStore((s) => s.dmRoomIdByContact);
  const removeContact = useRosterStore((s) => s.removeContact);
  const roomsById = useRoomStore((s) => s.roomsById);
  const callParticipantsByRoom = useRoomStore((s) => s.callParticipantsByRoom);
  const unreadByRoom = useRoomStore((s) => s.unreadByRoom);
  const pendingRequests = useFriendRequestStore((s) => s.pending.length);

  const activeCallRoomId = useRoomCallStore((s) => s.roomId);
  const activeCallParticipants = useRoomCallStore((s) => s.participants);
  const speakingIds = useRoomCallStore((s) => s.speakingIds);
  const camOnByParticipant = useRoomCallStore((s) => s.camOnByParticipant);
  const micOn = useRoomCallStore((s) => s.micOn);
  const camOn = useRoomCallStore((s) => s.camOn);

  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [memberNames, setMemberNames] = useState<Record<string, string>>({});
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(copiedTimer.current), []);

  const contacts = Object.values(contactsById).filter((c) => !c.revoked);
  const groupRooms = Object.values(roomsById).filter((r) => r.type === "group");

  useEffect(() => {
    let active = true;
    for (const room of groupRooms) {
      const pIds = callParticipantsByRoom[room.id];
      if (pIds && pIds.length > 0) {
        void roomMembersRepo.listMembersFull(room.id).then((members) => {
          if (!active) return;
          setMemberNames((prev) => {
            const next = { ...prev };
            for (const m of members) {
              if (m.displayName) next[m.id] = m.displayName;
            }
            return next;
          });
        });
      }
    }
    return () => {
      active = false;
    };
  }, [callParticipantsByRoom, groupRooms]);

  function copyId() {
    if (!self) return;
    void navigator.clipboard.writeText(self.identityId).then(() => {
      setCopied(true);
      clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 1_500);
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
            "flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[14px] font-medium transition-all duration-200",
            selection.kind === "home"
              ? "bg-bg-primary text-text-primary shadow-sm"
              : "text-text-secondary hover:bg-bg-secondary hover:text-text-primary hover:-translate-y-0.5",
          )}
        >
          <Home
            size={18}
            aria-hidden="true"
            className={
              selection.kind === "home" ? "text-accent" : "text-text-muted"
            }
          />
          Home &amp; invites
        </button>
      </div>

      <div className="mx-4 mt-1">
        <button
          onClick={() => onSelect({ kind: "inbox" })}
          aria-current={selection.kind === "inbox" ? "true" : undefined}
          className={cx(
            "flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[14px] font-medium transition-all duration-200",
            selection.kind === "inbox"
              ? "bg-bg-primary text-text-primary shadow-sm"
              : "text-text-secondary hover:bg-bg-secondary hover:text-text-primary hover:-translate-y-0.5",
          )}
        >
          <Inbox
            size={18}
            aria-hidden="true"
            className={
              selection.kind === "inbox" ? "text-accent" : "text-text-muted"
            }
          />
          <span className="flex-1">Inbox</span>
          <UnreadBadge count={pendingRequests} />
        </button>
      </div>

      <div className="flex items-center justify-between px-6 pt-8 pb-3">
        <span className="text-[12px] font-semibold tracking-wider text-text-muted uppercase">
          Spaces
        </span>
        <IconButton
          icon={Plus}
          label="Create a room"
          size="sm"
          onClick={onCreateGroup}
        />
      </div>
      <ul className="px-4 space-y-1">
        {groupRooms.map((room) => {
          const active =
            selection.kind === "group" && selection.roomId === room.id;
          const rawInCall = callParticipantsByRoom[room.id] ?? [];
          const inThisCall = activeCallRoomId === room.id;
          const callParticipants = Array.from(
            new Set([
              ...rawInCall,
              ...(inThisCall ? activeCallParticipants : []),
            ]),
          );
          const inCallCount = callParticipants.length;
          const unread = unreadByRoom[room.id] ?? 0;
          return (
            <li key={room.id} className="space-y-0.5">
              <button
                onClick={() => onSelect({ kind: "group", roomId: room.id })}
                aria-current={active ? "true" : undefined}
                className={cx(
                  "flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[14px] transition-all duration-200",
                  active
                    ? "bg-bg-primary font-medium text-text-primary shadow-sm"
                    : unread > 0
                      ? "font-semibold text-text-primary hover:bg-bg-secondary hover:-translate-y-0.5"
                      : "text-text-secondary hover:bg-bg-secondary hover:text-text-primary hover:-translate-y-0.5",
                )}
              >
                <Hash
                  size={18}
                  className={cx(
                    "shrink-0",
                    active ? "text-accent" : "text-text-muted",
                  )}
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1 truncate">
                  {room.name ?? "Room"}
                </span>
                {inCallCount > 0 && (
                  <span
                    className="flex shrink-0 items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-[11px] font-medium text-success"
                    title={`${inCallCount} in call`}
                  >
                    <Volume2
                      size={12}
                      className="animate-pulse"
                      aria-hidden="true"
                    />
                    {inCallCount}
                  </span>
                )}
                <UnreadBadge count={unread} />
              </button>

              {inCallCount > 0 && (
                <div className="ml-5 mt-0.5 border-l-2 border-success/30 pl-2 pr-1 py-0.5 space-y-0.5">
                  <ul className="space-y-0.5">
                    {callParticipants.map((id) => {
                      const isSelf = id === self?.identityId;
                      const name = isSelf
                        ? self?.displayName
                          ? `${self.displayName} (You)`
                          : "You"
                        : (contactsById[id]?.displayName ??
                          memberNames[id] ??
                          shortId(id));
                      const presence = presenceById[id] ?? "online";
                      const isSpeaking = speakingIds.has(id);
                      const hasCam = isSelf
                        ? inThisCall && camOn
                        : camOnByParticipant[id] === true;
                      const isMuted = isSelf ? inThisCall && !micOn : false;

                      return (
                        <li
                          key={id}
                          className="flex items-center justify-between rounded-lg px-2 py-1 text-[13px] text-text-secondary hover:bg-bg-secondary hover:text-text-primary transition-colors group/participant"
                        >
                          <div className="flex items-center gap-2 min-w-0 flex-1">
                            <Avatar
                              id={id}
                              name={name}
                              size="xs"
                              presence={presence}
                              className={cx(
                                "rounded-full transition-all",
                                isSpeaking
                                  ? "ring-2 ring-success shadow-[0_0_8px_rgba(59,165,92,0.6)]"
                                  : undefined,
                              )}
                            />
                            <span
                              className={cx(
                                "min-w-0 flex-1 truncate text-[12px]",
                                isSelf
                                  ? "font-semibold text-text-primary"
                                  : undefined,
                              )}
                            >
                              {name}
                            </span>
                          </div>
                          <div className="flex items-center gap-1 shrink-0 text-text-muted">
                            {hasCam && (
                              <span title="Camera on">
                                <Video
                                  size={12}
                                  className="text-accent"
                                  aria-hidden="true"
                                />
                              </span>
                            )}
                            {isSpeaking ? (
                              <span title="Speaking">
                                <Volume2
                                  size={12}
                                  className="text-success animate-pulse"
                                  aria-hidden="true"
                                />
                              </span>
                            ) : isMuted ? (
                              <span title="Muted">
                                <MicOff
                                  size={12}
                                  className="text-danger/80"
                                  aria-hidden="true"
                                />
                              </span>
                            ) : (
                              <span title="In call">
                                <Mic
                                  size={12}
                                  className="text-text-muted/60 opacity-0 group-hover/participant:opacity-100 transition-opacity"
                                  aria-hidden="true"
                                />
                              </span>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            </li>
          );
        })}
        {groupRooms.length === 0 && (
          <li className="px-3 py-2 text-[13px] text-text-muted">
            No spaces yet
          </li>
        )}
      </ul>

      <div className="px-6 pt-8 pb-3 text-[12px] font-semibold tracking-wider text-text-muted uppercase">
        Connections
      </div>
      <ul className="flex-1 overflow-y-auto px-4 space-y-1">
        {contacts.map((contact) => {
          const presence = presenceById[contact.identityId] ?? "offline";
          const active =
            selection.kind === "dm" &&
            selection.contactId === contact.identityId;
          const roomId = dmRoomIdByContact[contact.identityId];
          const unread = roomId ? (unreadByRoom[roomId] ?? 0) : 0;
          return (
            <li key={contact.identityId} className="group relative">
              <button
                onClick={() =>
                  onSelect({ kind: "dm", contactId: contact.identityId })
                }
                aria-current={active ? "true" : undefined}
                className={cx(
                  "flex w-full items-center gap-3 rounded-xl px-3 py-2.5 pr-8 text-left transition-all duration-200",
                  active
                    ? "bg-bg-primary shadow-sm"
                    : "hover:bg-bg-secondary hover:text-text-primary hover:-translate-y-0.5",
                )}
              >
                <Avatar
                  id={contact.identityId}
                  name={contact.displayName}
                  size="sm"
                  presence={presence}
                />
                <span
                  className={cx(
                    "min-w-0 flex-1 truncate text-[14px]",
                    active || unread > 0
                      ? "font-medium text-text-primary"
                      : "text-text-secondary",
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
      <div className="m-4 mt-2 flex shrink-0 items-center gap-3 rounded-2xl bg-bg-secondary p-3 shadow-sm transition-colors hover:bg-bg-tertiary">
        {self && (
          <Avatar id={self.identityId} name={self.displayName} size="md" />
        )}
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
            {copied ? (
              <Check size={12} aria-hidden="true" className="text-success" />
            ) : (
              <Copy size={12} aria-hidden="true" />
            )}
          </span>
        </button>
        <IconButton icon={Settings} label="Settings" onClick={onOpenSettings} />
      </div>
    </nav>
  );
}
