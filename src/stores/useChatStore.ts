import { create } from "zustand";
import type { DeliveryStatus, Message, Reaction } from "../types/domain";
import * as messageRepo from "../services/db/messageRepo";
import * as reactionRepo from "../services/db/reactionRepo";
import * as fileRepo from "../services/db/fileRepo";
import * as chatService from "../services/room/chatService";
import { useIdentityStore } from "./useIdentityStore";
import { useRoomStore } from "./useRoomStore";

type ChatState = {
  messagesByRoom: Record<string, Message[]>;
  draftByRoom: Record<string, string>;
  /** roomId -> messageId -> reactions on that message (reacted_at order). */
  reactionsByRoom: Record<string, Record<string, Reaction[]>>;
  /** The message the composer is replying to, per room (like drafts). */
  replyingToByRoom: Record<string, Message | null>;
  /** The message currently being edited, per room. Mutually exclusive with
   * replyingToByRoom (starting one clears the other). */
  editingByRoom: Record<string, Message | null>;

  loadMessages: (roomId: string) => Promise<void>;
  sendMessage: (roomId: string, memberIds: string[], body: string, file?: File) => Promise<void>;
  setDraft: (roomId: string, draft: string) => void;
  setReplyingTo: (roomId: string, message: Message | null) => void;
  setEditing: (roomId: string, message: Message | null) => void;
  /** Edits one of the local user's messages: re-signs, persists, broadcasts. */
  editMessage: (roomId: string, memberIds: string[], messageId: string, body: string) => Promise<void>;
  /** Deletes (tombstones) one of the local user's messages. */
  deleteMessage: (roomId: string, memberIds: string[], messageId: string) => Promise<void>;
  /** Bridge/local-echo: replace a message in place after an edit/delete. */
  applyMessageUpdate: (message: Message) => void;
  /** Adds or removes the local user's reaction, persists it, and broadcasts
   * the toggle to connected room members. */
  toggleReaction: (
    roomId: string,
    memberIds: string[],
    messageId: string,
    emoji: string,
  ) => Promise<void>;
  /** Bridge-called: a peer's reaction toggle arrived and is already persisted. */
  ingestReaction: (reaction: Reaction, op: "add" | "remove") => void;
  /** Reloads a room's reactions from the DB (after a sync backfill replaced
   * an author's set wholesale). */
  refreshReactions: (roomId: string) => Promise<void>;
  /** Bridge-called: a message arrived/backfilled from the network and was
   * already persisted; reflect it in the in-memory list if the room is loaded. */
  ingestMessage: (message: Message) => void;
  /** Bridge-called: like `ingestMessage` but for a batch (sync backfill) — one
   * merge + sort per room and a single room-list refresh. */
  ingestMessages: (messages: Message[]) => void;
  /** Bridge-called: a delivery receipt arrived; the repo row is already updated. */
  updateMessageStatus: (roomId: string, messageId: string, status: DeliveryStatus) => void;
  /** Reloads a room's messages from the DB, but only if it's already loaded. */
  refreshRoom: (roomId: string) => Promise<void>;
};

const byHlc = (a: Message, b: Message) => (a.hlc < b.hlc ? -1 : a.hlc > b.hlc ? 1 : 0);

function insertOrdered(list: Message[], message: Message): Message[] {
  if (list.some((m) => m.id === message.id)) return list;
  return [...list, message].sort(byHlc);
}

/** Merges two id-keyed message lists (deduped, hlc-ordered); `fresh` wins on
 * id conflicts. Used so a slow reload can't clobber messages appended while its
 * query was in flight. */
function mergeById(existing: Message[], fresh: Message[]): Message[] {
  const byId = new Map<string, Message>();
  for (const m of existing) byId.set(m.id, m);
  for (const m of fresh) byId.set(m.id, m);
  return [...byId.values()].sort(byHlc);
}

function groupByMessage(reactions: Reaction[]): Record<string, Reaction[]> {
  const byMessage: Record<string, Reaction[]> = {};
  for (const r of reactions) (byMessage[r.messageId] ??= []).push(r);
  return byMessage;
}

export const useChatStore = create<ChatState>((set, get) => ({
  messagesByRoom: {},
  draftByRoom: {},
  reactionsByRoom: {},
  replyingToByRoom: {},
  editingByRoom: {},

  loadMessages: async (roomId) => {
    const [messages, reactions] = await Promise.all([
      messageRepo.listByRoom(roomId),
      reactionRepo.listByRoom(roomId),
    ]);
    set((state) => {
      const existing = state.messagesByRoom[roomId];
      // Merge, don't overwrite: a message may have been ingested from the
      // network while this query was in flight, and it must not vanish.
      const next = existing ? mergeById(existing, messages) : messages;
      return {
        messagesByRoom: { ...state.messagesByRoom, [roomId]: next },
        reactionsByRoom: { ...state.reactionsByRoom, [roomId]: groupByMessage(reactions) },
      };
    });
  },

  sendMessage: async (roomId, memberIds, body, file) => {
    const self = useIdentityStore.getState().self;
    if (!self) throw new Error("no local identity");
    const trimmed = body.trim();
    if (!trimmed && !file) return;

    let attachment: { id: string; name: string; size: number; type: string } | undefined;
    let fileBuffer: Uint8Array | undefined;
    if (file) {
      const id = crypto.randomUUID();
      const buffer = await file.arrayBuffer();
      fileBuffer = new Uint8Array(buffer);
      await fileRepo.insertFile({
        id,
        name: file.name,
        size: file.size,
        mimeType: file.type,
        data: fileBuffer,
      });
      attachment = { id, name: file.name, size: file.size, type: file.type };
    }

    const message = await chatService.sendMessage(
      self,
      roomId,
      memberIds,
      trimmed,
      Date.now(),
      attachment,
      fileBuffer,
      get().replyingToByRoom[roomId]?.id ?? null
    );
    set((state) => ({
      messagesByRoom: {
        ...state.messagesByRoom,
        [roomId]: insertOrdered(state.messagesByRoom[roomId] ?? [], message),
      },
      draftByRoom: { ...state.draftByRoom, [roomId]: "" },
      replyingToByRoom: { ...state.replyingToByRoom, [roomId]: null },
    }));
    void useRoomStore.getState().loadRooms();
  },

  setDraft: (roomId, draft) =>
    set((state) => ({ draftByRoom: { ...state.draftByRoom, [roomId]: draft } })),

  setReplyingTo: (roomId, message) =>
    set((state) => ({
      replyingToByRoom: { ...state.replyingToByRoom, [roomId]: message },
      // Replying and editing are mutually exclusive.
      editingByRoom: message ? { ...state.editingByRoom, [roomId]: null } : state.editingByRoom,
    })),

  setEditing: (roomId, message) =>
    set((state) => ({
      editingByRoom: { ...state.editingByRoom, [roomId]: message },
      replyingToByRoom: message ? { ...state.replyingToByRoom, [roomId]: null } : state.replyingToByRoom,
    })),

  editMessage: async (roomId, memberIds, messageId, body) => {
    const self = useIdentityStore.getState().self;
    if (!self) return;
    const updated = await chatService.sendEdit(self, roomId, memberIds, messageId, body.trim(), Date.now());
    if (updated) get().applyMessageUpdate(updated);
    set((state) => ({
      editingByRoom: { ...state.editingByRoom, [roomId]: null },
      draftByRoom: { ...state.draftByRoom, [roomId]: "" },
    }));
  },

  deleteMessage: async (roomId, memberIds, messageId) => {
    const self = useIdentityStore.getState().self;
    if (!self) return;
    const updated = await chatService.sendDelete(self, roomId, memberIds, messageId, Date.now());
    if (updated) get().applyMessageUpdate(updated);
  },

  applyMessageUpdate: (message) => {
    const loaded = get().messagesByRoom[message.roomId];
    if (!loaded) return;
    set((state) => ({
      messagesByRoom: {
        ...state.messagesByRoom,
        [message.roomId]: loaded.map((m) => (m.id === message.id ? { ...m, ...message } : m)),
      },
    }));
  },

  toggleReaction: async (roomId, memberIds, messageId, emoji) => {
    const self = useIdentityStore.getState().self;
    if (!self) return;
    const existing = get().reactionsByRoom[roomId]?.[messageId] ?? [];
    const op = existing.some((r) => r.authorId === self.identityId && r.emoji === emoji)
      ? "remove"
      : "add";
    const reaction = await chatService.sendReaction(
      self,
      roomId,
      memberIds,
      messageId,
      emoji,
      op,
      Date.now(),
    );
    get().ingestReaction(reaction, op);
  },

  ingestReaction: (reaction, op) => {
    set((state) => {
      const room = state.reactionsByRoom[reaction.roomId] ?? {};
      const list = room[reaction.messageId] ?? [];
      const without = list.filter(
        (r) => !(r.authorId === reaction.authorId && r.emoji === reaction.emoji),
      );
      const nextList = op === "add" ? [...without, reaction] : without;
      return {
        reactionsByRoom: {
          ...state.reactionsByRoom,
          [reaction.roomId]: { ...room, [reaction.messageId]: nextList },
        },
      };
    });
  },

  refreshReactions: async (roomId) => {
    const reactions = await reactionRepo.listByRoom(roomId);
    set((state) => ({
      reactionsByRoom: { ...state.reactionsByRoom, [roomId]: groupByMessage(reactions) },
    }));
  },

  ingestMessage: (message) => {
    get().ingestMessages([message]);
  },

  ingestMessages: (messages) => {
    if (messages.length === 0) return;
    set((state) => {
      const next = { ...state.messagesByRoom };
      let changed = false;
      // Group additions per already-loaded room, then sort each room once.
      for (const roomId of new Set(messages.map((m) => m.roomId))) {
        const loaded = next[roomId];
        if (!loaded) continue;
        const seen = new Set(loaded.map((m) => m.id));
        const additions = messages.filter((m) => m.roomId === roomId && !seen.has(m.id));
        if (additions.length === 0) continue;
        next[roomId] = [...loaded, ...additions].sort(byHlc);
        changed = true;
      }
      return changed ? { messagesByRoom: next } : state;
    });
    void useRoomStore.getState().loadRooms();
  },

  updateMessageStatus: (roomId, messageId, status) => {
    const loaded = get().messagesByRoom[roomId];
    if (!loaded) return;
    set((state) => ({
      messagesByRoom: {
        ...state.messagesByRoom,
        [roomId]: loaded.map((m) =>
          m.id === messageId ? { ...m, deliveryStatus: status } : m,
        ),
      },
    }));
  },

  refreshRoom: async (roomId) => {
    if (get().messagesByRoom[roomId]) await get().loadMessages(roomId);
  },
}));
