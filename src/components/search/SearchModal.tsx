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

type SearchModalProps = {
  open: boolean;
  onClose: () => void;
  onPick: (roomId: string, messageId: string) => void;
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

  function pick(r: SearchResult) {
    onPick(r.message.roomId, r.message.id);
    onClose();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (results.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const r = results[selected];
      if (r) pick(r);
    }
  }

  const trimmed = query.trim();
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
            <EmptyState icon={Search} title="Type to search" description="Find any message across your rooms." />
          ) : loading ? (
            <EmptyState icon={Search} title="Searching…" />
          ) : results.length === 0 ? (
            <EmptyState icon={Search} title="No results" description={`No messages match “${trimmed}”.`} />
          ) : (
            <ul className="flex flex-col gap-1">
              {results.map((r, i) => {
                const { name, dm } = roomLabel(r.message.roomId);
                return (
                  <li key={r.message.id}>
                    <button
                      type="button"
                      onClick={() => pick(r)}
                      onMouseEnter={() => setSelected(i)}
                      className={cx(
                        "flex w-full flex-col gap-0.5 rounded-lg px-3 py-2 text-left transition-colors",
                        i === selected ? "bg-accent/10" : "hover:bg-bg-tertiary/60",
                      )}
                    >
                      <div className="flex items-center gap-1.5 text-xs text-text-muted">
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
                      <p className="truncate text-sm text-text-primary">{highlight(r.snippet)}</p>
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
