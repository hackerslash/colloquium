import { useEffect, useMemo, useRef, useState } from "react";
import { Hash, Search, User } from "lucide-react";
import { Modal } from "../ui/Modal";
import { EmptyState } from "../ui/EmptyState";
import { useRoomStore } from "../../stores/useRoomStore";
import { useRosterStore } from "../../stores/useRosterStore";
import { useIdentityStore } from "../../stores/useIdentityStore";
import * as messageRepo from "../../services/db/messageRepo";
import type { SearchResult } from "../../services/db/messageRepo";
import { cx } from "../../lib/cx";

const DEBOUNCE_MS = 200;
const MIN_CHARS = 2;
const MARK_OPEN = String.fromCharCode(1);
const MARK_CLOSE = String.fromCharCode(2);

function timeLabel(ms: number): string {
  const d = new Date(ms);
  const date = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${date} · ${time}`;
}

/** Splits an FTS snippet on the char(1)/char(2) sentinels into <mark>ed
 * matched runs and plain text. */
function highlight(snippet: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let key = 0;
  for (const chunk of snippet.split(MARK_OPEN)) {
    const close = chunk.indexOf(MARK_CLOSE);
    if (close === -1) {
      if (chunk) parts.push(chunk);
      continue;
    }
    parts.push(
      <mark key={key++} className="rounded bg-accent/25 px-0.5 text-text-primary">
        {chunk.slice(0, close)}
      </mark>,
    );
    const rest = chunk.slice(close + 1);
    if (rest) parts.push(rest);
  }
  return parts;
}

const MAX_JUMP_MATCHES = 5;

/** One flat list so ↑/↓ and Enter cross the name/message boundary. */
type Item =
  | { kind: "jump"; key: string; roomId: string; name: string; dm: boolean }
  | { kind: "message"; key: string; result: SearchResult };

type SearchModalProps = {
  open: boolean;
  onClose: () => void;
  /** `messageId` is null for a conversation jump — open it, don't scroll. */
  onPick: (roomId: string, messageId: string | null) => void;
};

export function SearchModal({ open, onClose, onPick }: SearchModalProps) {
  const roomsById = useRoomStore((s) => s.roomsById);
  const activeRoomId = useRoomStore((s) => s.activeRoomId);
  const dmRoomIdByContact = useRosterStore((s) => s.dmRoomIdByContact);
  const contactsById = useRosterStore((s) => s.contactsById);
  const self = useIdentityStore((s) => s.self);

  const [query, setQuery] = useState("");
  const [scopeRoom, setScopeRoom] = useState(false);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reverse map: dm roomId -> contactId, for labelling dm results.
  const contactByDmRoom = useMemo(() => {
    const m = new Map<string, string>();
    for (const [contactId, roomId] of Object.entries(dmRoomIdByContact)) m.set(roomId, contactId);
    return m;
  }, [dmRoomIdByContact]);

  function roomLabel(roomId: string): { name: string; dm: boolean } {
    const room = roomsById[roomId];
    if (room?.type === "group") return { name: room.name ?? "Room", dm: false };
    const contactId = contactByDmRoom.get(roomId);
    return {
      name: contactId ? contactsById[contactId]?.displayName ?? "Unknown" : "Direct message",
      dm: true,
    };
  }

  function authorName(authorId: string): string {
    if (authorId === self?.identityId) return self?.displayName ?? "You";
    return contactsById[authorId]?.displayName ?? "Unknown";
  }

  // Reset transient state whenever the modal opens.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setScopeRoom(false);
    setResults([]);
    setSelected(0);
    const id = window.setTimeout(() => inputRef.current?.focus(), 50);
    return () => window.clearTimeout(id);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const trimmed = query.trim();
    if (trimmed.length < MIN_CHARS) {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    let cancelled = false;
    const id = window.setTimeout(() => {
      const opts = scopeRoom && activeRoomId ? { roomId: activeRoomId } : undefined;
      messageRepo
        .searchMessages(trimmed, opts)
        .then((r) => {
          if (cancelled) return;
          setResults(r);
          setSelected(0);
        })
        .catch((err) => {
          if (!cancelled) console.error("search failed", err);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
  }, [open, query, scopeRoom, activeRoomId]);

  const trimmed = query.trim();

  const jumps = useMemo<Item[]>(() => {
    const needle = trimmed.toLowerCase();
    if (needle.length < MIN_CHARS) return [];
    const out: Item[] = [];
    for (const c of Object.values(contactsById)) {
      if (c.revoked || !c.displayName.toLowerCase().includes(needle)) continue;
      const roomId = dmRoomIdByContact[c.identityId];
      if (roomId) {
        out.push({ kind: "jump", key: `dm:${c.identityId}`, roomId, name: c.displayName, dm: true });
      }
    }
    for (const room of Object.values(roomsById)) {
      if (room.type !== "group") continue;
      const name = room.name ?? "Room";
      if (!name.toLowerCase().includes(needle)) continue;
      out.push({ kind: "jump", key: `group:${room.id}`, roomId: room.id, name, dm: false });
    }
    return out.slice(0, MAX_JUMP_MATCHES);
  }, [trimmed, contactsById, dmRoomIdByContact, roomsById]);

  const items = useMemo<Item[]>(
    () => [
      ...jumps,
      ...results.map((result): Item => ({ kind: "message", key: result.message.id, result })),
    ],
    [jumps, results],
  );

  // The list shrinks as the query narrows; a stale index would break Enter.
  const activeIndex = Math.min(selected, items.length - 1);

  function pick(item: Item) {
    if (item.kind === "jump") onPick(item.roomId, null);
    else onPick(item.result.message.roomId, item.result.message.id);
    onClose();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (items.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected(Math.min(activeIndex + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected(Math.max(activeIndex - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = items[activeIndex];
      if (item) pick(item);
    }
  }

  const activeRoomName = activeRoomId ? roomLabel(activeRoomId).name : null;

  return (
    <Modal open={open} onClose={onClose} title="Search messages" size="lg">
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2 rounded-xl border border-border bg-bg-tertiary/60 px-3">
          <Search size={16} className="shrink-0 text-text-muted" aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search messages…"
            className="flex-1 bg-transparent py-2.5 text-sm text-text-primary outline-none placeholder:text-text-muted"
          />
        </div>

        {activeRoomId && activeRoomName && (
          <div>
            <button
              type="button"
              onClick={() => setScopeRoom((v) => !v)}
              className={cx(
                "rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
                scopeRoom
                  ? "border-accent/60 bg-accent/15 text-accent"
                  : "border-border bg-bg-tertiary text-text-secondary hover:border-border/80",
              )}
            >
              This room: {activeRoomName}
            </button>
          </div>
        )}

        <div className="max-h-[50vh] min-h-[8rem] overflow-y-auto">
          {trimmed.length < MIN_CHARS ? (
            <EmptyState
              icon={Search}
              title="Type to search"
              description="Jump to a person or room, or find any message."
            />
          ) : items.length === 0 ? (
            loading ? (
              <EmptyState icon={Search} title="Searching…" />
            ) : (
              <EmptyState icon={Search} title="No results" description={`Nothing matches “${trimmed}”.`} />
            )
          ) : (
            <ul className="flex flex-col gap-1">
              {items.map((item, i) => {
                const active = i === activeIndex;
                const rowClass = cx(
                  "flex w-full rounded-lg px-3 py-2 text-left transition-colors",
                  active ? "bg-accent/10" : "hover:bg-bg-tertiary/60",
                );
                if (item.kind === "jump") {
                  return (
                    <li key={item.key}>
                      <button
                        type="button"
                        onClick={() => pick(item)}
                        onMouseEnter={() => setSelected(i)}
                        className={cx(rowClass, "items-center gap-2")}
                      >
                        {item.dm ? (
                          <User size={14} className="shrink-0 text-text-muted" />
                        ) : (
                          <Hash size={14} className="shrink-0 text-text-muted" />
                        )}
                        <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">
                          {item.name}
                        </span>
                        <span className="shrink-0 text-xs text-text-muted">
                          {item.dm ? "Open conversation" : "Open room"}
                        </span>
                      </button>
                    </li>
                  );
                }
                const r = item.result;
                const { name, dm } = roomLabel(r.message.roomId);
                return (
                  <li key={item.key}>
                    <button
                      type="button"
                      onClick={() => pick(item)}
                      onMouseEnter={() => setSelected(i)}
                      className={cx(rowClass, "flex-col gap-0.5")}
                    >
                      <div className="flex w-full items-center gap-1.5 text-xs text-text-muted">
                        {dm ? (
                          <User size={12} className="shrink-0" />
                        ) : (
                          <Hash size={12} className="shrink-0" />
                        )}
                        <span className="font-semibold text-text-secondary">{name}</span>
                        <span aria-hidden="true">·</span>
                        <span>{authorName(r.message.authorId)}</span>
                        <span className="ml-auto shrink-0">{timeLabel(r.message.sentAt)}</span>
                      </div>
                      <p className="w-full truncate text-sm text-text-primary">{highlight(r.snippet)}</p>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </Modal>
  );
}
