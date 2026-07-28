import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useIdentityStore } from "../../stores/useIdentityStore";
import { useRosterStore } from "../../stores/useRosterStore";
import { useRoomStore } from "../../stores/useRoomStore";
import { initNetworkBridge } from "../../services/bridge/networkBridge";
import { Sidebar, type Selection } from "./Sidebar";
import { HomeView } from "../invite/HomeView";
import { ChatView } from "../chat/ChatView";
import { GroupRoomView } from "../room/GroupRoomView";
import { CreateGroupModal } from "../room/CreateGroupModal";
import { CallOverlay } from "../call/CallOverlay";
import { RoomCallWindow } from "../call/RoomCallWindow";
import { WatchPartyWindow } from "../watchparty/WatchPartyWindow";
import { SettingsModal } from "../settings/SettingsModal";
import { SearchModal } from "../search/SearchModal";
import { useGlobalShortcuts } from "../../hooks/useGlobalShortcuts";

let bridgeStarted = false;

function selectionKey(s: Selection): string {
  return s.kind === "dm" ? `dm:${s.contactId}` : s.kind === "group" ? `group:${s.roomId}` : s.kind;
}

export function MainShell() {
  const self = useIdentityStore((s) => s.self);
  const loadRoster = useRosterStore((s) => s.loadRoster);
  const loadRooms = useRoomStore((s) => s.loadRooms);
  const loadUnread = useRoomStore((s) => s.loadUnread);
  const loadMuted = useRoomStore((s) => s.loadMuted);
  const markRead = useRoomStore((s) => s.markRead);
  const activeRoomId = useRoomStore((s) => s.activeRoomId);
  const roomsById = useRoomStore((s) => s.roomsById);
  const dmRoomIdByContact = useRosterStore((s) => s.dmRoomIdByContact);
  const [selection, setSelection] = useState<Selection>({ kind: "home" });
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [jumpTarget, setJumpTarget] = useState<{ key: string; messageId: string } | null>(null);

  useGlobalShortcuts({
    onOpenSettings: () => setSettingsOpen(true),
    onOpenSearch: () => setSearchOpen(true),
  });

  function selectionForRoom(roomId: string): Selection | null {
    if (roomsById[roomId]?.type === "group") return { kind: "group", roomId };
    const dm = Object.entries(dmRoomIdByContact).find(([, rid]) => rid === roomId);
    return dm ? { kind: "dm", contactId: dm[0] } : null;
  }

  function jumpFor(sel: Selection): string | null {
    return jumpTarget && jumpTarget.key === selectionKey(sel) ? jumpTarget.messageId : null;
  }

  useEffect(() => {
    void loadRoster();
    // Mute state must load before unread so the first badge computation
    // already excludes muted rooms from the dock count.
    void loadRooms().then(() => loadMuted().then(() => loadUnread()));
  }, [loadRoster, loadRooms, loadMuted, loadUnread]);

  useEffect(() => {
    if (!self || bridgeStarted) return;
    bridgeStarted = true;
    initNetworkBridge(self);
  }, [self]);

  useEffect(() => {
    function onFocus() {
      if (activeRoomId) void markRead(activeRoomId);
    }
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [activeRoomId, markRead]);

  return (
    <div id="app-shell" className="flex h-full text-text-primary bg-bg-base">
      <Sidebar
        selection={selection}
        onSelect={setSelection}
        onCreateGroup={() => setCreatingGroup(true)}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <main className="flex min-w-0 flex-1 flex-col relative overflow-hidden bg-bg-primary m-2 ml-0 rounded-[20px] shadow-soft border border-border/40">
        <AnimatePresence>
          <motion.div
            key={selectionKey(selection)}
            initial={{ opacity: 0, position: "absolute", inset: 0, y: 4 }}
            animate={{ opacity: 1, position: "relative", inset: "auto", y: 0 }}
            exit={{ opacity: 0, position: "absolute", inset: 0 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="flex min-h-0 flex-1 flex-col"
          >
            {selection.kind === "dm" ? (
              <ChatView
                contactId={selection.contactId}
                jumpToMessageId={jumpFor(selection)}
                onJumpConsumed={() => setJumpTarget(null)}
              />
            ) : selection.kind === "group" ? (
              <GroupRoomView
                roomId={selection.roomId}
                onLeft={() => setSelection({ kind: "home" })}
                jumpToMessageId={jumpFor(selection)}
                onJumpConsumed={() => setJumpTarget(null)}
              />
            ) : (
              <div className="flex-1 overflow-y-auto">
                <HomeView />
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      </main>

      <CreateGroupModal
        open={creatingGroup}
        onClose={() => setCreatingGroup(false)}
        onCreated={(roomId) => {
          setCreatingGroup(false);
          setSelection({ kind: "group", roomId });
        }}
      />
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <SearchModal
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onPick={(roomId, messageId) => {
          const sel = selectionForRoom(roomId);
          if (!sel) return;
          setSelection(sel);
          setJumpTarget({ key: selectionKey(sel), messageId });
        }}
      />
      <CallOverlay />
      <RoomCallWindow />
      <WatchPartyWindow />
    </div>
  );
}
