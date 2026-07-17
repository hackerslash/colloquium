import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useIdentityStore } from "../../stores/useIdentityStore";
import { useRosterStore } from "../../stores/useRosterStore";
import { useRoomStore } from "../../stores/useRoomStore";
import { useFriendRequestStore } from "../../stores/useFriendRequestStore";
import { initNetworkBridge } from "../../services/bridge/networkBridge";
import { Sidebar, type Selection } from "./Sidebar";
import { HomeView } from "../invite/HomeView";
import { InboxView } from "../invite/InboxView";
import { ChatView } from "../chat/ChatView";
import { GroupRoomView } from "../room/GroupRoomView";
import { CreateGroupModal } from "../room/CreateGroupModal";
import { CallOverlay } from "../call/CallOverlay";
import { SettingsModal } from "../settings/SettingsModal";
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
  const refreshFriendRequests = useFriendRequestStore((s) => s.refresh);
  const markRead = useRoomStore((s) => s.markRead);
  const activeRoomId = useRoomStore((s) => s.activeRoomId);
  const [selection, setSelection] = useState<Selection>({ kind: "home" });
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useGlobalShortcuts({ onOpenSettings: () => setSettingsOpen(true) });

  useEffect(() => {
    void loadRoster();
    void loadRooms().then(() => loadUnread());
    void refreshFriendRequests();
  }, [loadRoster, loadRooms, loadUnread, refreshFriendRequests]);

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
    <div className="flex h-full text-text-primary bg-bg-base">
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
              <ChatView contactId={selection.contactId} />
            ) : selection.kind === "group" ? (
              <GroupRoomView roomId={selection.roomId} onLeft={() => setSelection({ kind: "home" })} />
            ) : selection.kind === "inbox" ? (
              <InboxView />
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
      <CallOverlay />
    </div>
  );
}
