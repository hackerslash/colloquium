import { useEffect, useState } from "react";
import { useIdentityStore } from "../../stores/useIdentityStore";
import { useRosterStore } from "../../stores/useRosterStore";
import { useRoomStore } from "../../stores/useRoomStore";
import { initNetworkBridge } from "../../services/bridge/networkBridge";
import { Sidebar } from "./Sidebar";
import { HomeView } from "../invite/HomeView";
import { ChatView } from "../chat/ChatView";
import { CallOverlay } from "../call/CallOverlay";

let bridgeStarted = false;

function shortId(identityId: string): string {
  return `${identityId.slice(0, 8)}…${identityId.slice(-4)}`;
}

export function MainShell() {
  const self = useIdentityStore((s) => s.self);
  const loadRoster = useRosterStore((s) => s.loadRoster);
  const loadRooms = useRoomStore((s) => s.loadRooms);
  const [selectedContactId, setSelectedContactId] = useState<string | null>(null);

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
        selectedContactId={selectedContactId}
        onSelectHome={() => setSelectedContactId(null)}
        onSelectContact={setSelectedContactId}
      />
      <div className="flex flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-border px-4 py-2">
          <span className="text-sm text-text-secondary">Haven</span>
          <span className="flex items-center gap-2 text-xs text-text-secondary">
            <span className="font-medium text-text-primary">{self?.displayName}</span>
            <span className="font-mono">{self ? shortId(self.identityId) : null}</span>
          </span>
        </header>
        <div className="flex flex-1 overflow-hidden">
          {selectedContactId ? (
            <ChatView key={selectedContactId} contactId={selectedContactId} />
          ) : (
            <div className="flex-1 overflow-y-auto">
              <HomeView />
            </div>
          )}
        </div>
      </div>
      <CallOverlay />
    </div>
  );
}
