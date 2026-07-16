import { useEffect, useState } from "react";
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

function shortId(identityId: string): string {
  return `${identityId.slice(0, 8)}…${identityId.slice(-4)}`;
}

export function MainShell() {
  const self = useIdentityStore((s) => s.self);
  const loadRoster = useRosterStore((s) => s.loadRoster);
  const loadRooms = useRoomStore((s) => s.loadRooms);
  const [selection, setSelection] = useState<Selection>({ kind: "home" });
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useGlobalShortcuts({ onOpenSettings: () => setSettingsOpen(true) });

  useEffect(() => {
    void loadRoster();
    void loadRooms();
  }, [loadRoster, loadRooms]);

  useEffect(() => {
    if (!self || bridgeStarted) return;
    bridgeStarted = true;
    initNetworkBridge(self);
  }, [self]);

  return (
    <div className="flex h-full bg-bg-primary text-text-primary">
      <Sidebar
        selection={selection}
        onSelect={setSelection}
        onCreateGroup={() => setCreatingGroup(true)}
      />
      <div className="flex flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-border px-4 py-2">
          <span className="text-sm text-text-secondary">Haven</span>
          <span className="flex items-center gap-3 text-xs text-text-secondary">
            <span className="font-medium text-text-primary">{self?.displayName}</span>
            <span className="font-mono">{self ? shortId(self.identityId) : null}</span>
            <button
              onClick={() => setSettingsOpen(true)}
              aria-label="Open settings"
              title="Settings"
              className="rounded px-1.5 py-0.5 hover:bg-bg-tertiary hover:text-text-primary"
            >
              ⚙
            </button>
          </span>
        </header>
        <div className="flex flex-1 overflow-hidden">
          {selection.kind === "dm" ? (
            <ChatView key={selection.contactId} contactId={selection.contactId} />
          ) : selection.kind === "group" ? (
            <GroupRoomView key={selection.roomId} roomId={selection.roomId} />
          ) : (
            <div className="flex-1 overflow-y-auto">
              <HomeView />
            </div>
          )}
        </div>
      </div>

      {creatingGroup && (
        <CreateGroupModal
          onClose={() => setCreatingGroup(false)}
          onCreated={(roomId) => {
            setCreatingGroup(false);
            setSelection({ kind: "group", roomId });
          }}
        />
      )}
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      <CallOverlay />
    </div>
  );
}
