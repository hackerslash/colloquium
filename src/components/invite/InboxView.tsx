import { useEffect } from "react";
import { Check, X } from "lucide-react";
import { useIdentityStore } from "../../stores/useIdentityStore";
import { useFriendRequestStore } from "../../stores/useFriendRequestStore";
import type * as friendRequestsRepo from "../../services/db/friendRequestsRepo";
import * as friendRequestService from "../../services/roster/friendRequestService";
import { reflectNewContactLocally } from "../../services/bridge/networkBridge";
import { Avatar } from "../ui/Avatar";
import { IconButton } from "../ui/IconButton";
import { EmptyState } from "../ui/EmptyState";
import { Inbox } from "lucide-react";

export function InboxView() {
  const self = useIdentityStore((s) => s.self);
  const requests = useFriendRequestStore((s) => s.pending);
  const refresh = useFriendRequestStore((s) => s.refresh);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleAccept(req: friendRequestsRepo.FriendRequest) {
    if (!self) return;
    await friendRequestService.acceptFriendRequest(self, req);
    await reflectNewContactLocally(self, req.fromId);
    await refresh();
  }

  async function handleDecline(req: friendRequestsRepo.FriendRequest) {
    if (!self) return;
    await friendRequestService.declineFriendRequest(self, req);
    await refresh();
  }

  if (requests.length === 0) {
    return <EmptyState icon={Inbox} title="No pending invites" />;
  }

  return (
    <div className="flex h-full flex-col bg-bg-primary">
      <header className="flex h-14 shrink-0 items-center border-b border-border/50 px-8">
        <h1 className="font-display italic text-lg font-normal text-text-primary">Inbox</h1>
      </header>
      <div className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-2xl">
          <ul className="flex flex-col gap-3">
            {requests.map((req) => (
              <li
                key={req.id}
                className="flex items-center justify-between rounded-[20px] border border-border/50 bg-bg-secondary p-4 shadow-sm transition-shadow hover:shadow-soft"
              >
                <div className="flex items-center gap-4">
                  <Avatar id={req.fromId} name={req.displayName} size="md" />
                  <div>
                    <p className="text-[15px] font-semibold text-text-primary">{req.displayName}</p>
                    <p className="text-[13px] text-text-secondary">Wants to connect securely</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <IconButton
                    icon={Check}
                    label="Accept"
                    variant="solid"
                    onClick={() => void handleAccept(req)}
                    className="bg-accent text-accent-ink hover:bg-accent-hover shadow-sm"
                  />
                  <IconButton
                    icon={X}
                    label="Decline"
                    variant="danger"
                    onClick={() => void handleDecline(req)}
                  />
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
