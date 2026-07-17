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
import { SettingsModal } from "../settings/SettingsModal";
import { useGlobalShortcuts } from "../../hooks/useGlobalShortcuts";

let bridgeStarted = false;

function selectionKey(s: Selection): string {
  return s.kind === "dm" ? `dm:${s.contactId}` : s.kind === "group" ? `group:${s.roomId}` : "home";
}

export function MainShell() {
  const self = useIdentityStore((s) => s.self);
  const loadRoster = useRosterStore((s) => s.loadRoster);
  const loadRooms = useRoomStore((s) => s.loadRooms);
  const loadUnread = useRoomStore((s) => s.loadUnread);
  const markRead = useRoomStore((s) => s.markRead);
  const activeRoomId = useRoomStore((s) => s.activeRoomId);
  const [selection, setSelection] = useState<Selection>({ kind: "home" });
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useGlobalShortcuts({ onOpenSettings: () => setSettingsOpen(true) });

  useEffect(() => {
    void loadRoster();
    void loadRooms().then(() => loadUnread());
  }, [loadRoster, loadRooms, loadUnread]);

  useEffect(() => {
    if (!self || bridgeStarted) return;
    bridgeStarted = true;
    initNetworkBridge(self);
  }, [self]);

  // Regaining window focus reads whatever room the user is looking at.
  useEffect(() => {
    function onFocus() {
      if (activeRoomId) void markRead(activeRoomId);
    }
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [activeRoomId, markRead]);

  return (
    <div className="flex h-full bg-bg-primary text-text-primary">
      <Sidebar
        selection={selection}
        onSelect={setSelection}
        onCreateGroup={() => setCreatingGroup(true)}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <main className="flex min-w-0 flex-1 flex-col">
        <AnimatePresence mode="wait">
          <motion.div
            key={selectionKey(selection)}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
            className="flex min-h-0 flex-1 flex-col"
          >
            {selection.kind === "dm" ? (
              <ChatView contactId={selection.contactId} />
            ) : selection.kind === "group" ? (
              <GroupRoomView roomId={selection.roomId} />
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
