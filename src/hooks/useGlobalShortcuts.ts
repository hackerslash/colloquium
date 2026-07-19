import { useEffect } from "react";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import { useSettingsStore } from "../stores/useSettingsStore";
import { useCallStore } from "../stores/useCallStore";
import { useRoomCallStore } from "../stores/useRoomCallStore";
import * as callService from "../services/call/callService";
import * as roomCallService from "../services/call/roomCallService";
import { toast } from "../stores/useToastStore";
import { isMacOS, MACOS_QUARANTINE_HINT } from "../services/call/systemAudio";

const PTT_SHORTCUT = "CommandOrControl+Shift+Space";

function anyCallActive(): boolean {
  return callService.isCallActive() || roomCallService.isInRoomCall();
}

/** Sets mic enabled on whichever call (1:1 or room) is active. */
function setActiveMic(enabled: boolean) {
  if (callService.isCallActive()) callService.setMic(enabled);
  if (roomCallService.isInRoomCall()) roomCallService.setMic(enabled);
}

function isTypingTarget(el: EventTarget | null): boolean {
  const node = el as HTMLElement | null;
  if (!node) return false;
  const tag = node.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || node.isContentEditable;
}

type Options = {
  onOpenSettings: () => void;
  onOpenSearch: () => void;
};

export function useGlobalShortcuts({ onOpenSettings, onOpenSearch }: Options) {
  const pushToTalk = useSettingsStore((s) => s.pushToTalk);

  // In-app (DOM) shortcuts.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === ",") {
        e.preventDefault();
        onOpenSettings();
        return;
      }
      if (mod && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        onOpenSearch();
        return;
      }
      // Mute toggle with "m" while in a call and not typing.
      if (!mod && (e.key === "m" || e.key === "M") && anyCallActive() && !isTypingTarget(e.target)) {
        e.preventDefault();
        if (callService.isCallActive()) useCallStore.getState().toggleMic();
        if (roomCallService.isInRoomCall()) useRoomCallStore.getState().toggleMic();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onOpenSettings, onOpenSearch]);

  // OS-level push-to-talk: hold to unmute, release to mute — works even when
  // the window is unfocused. Registered only while the setting is enabled.
  useEffect(() => {
    if (!pushToTalk) return;
    let registered = false;
    let cancelled = false;

    void register(PTT_SHORTCUT, (event) => {
      if (!anyCallActive()) return;
      if (event.state === "Pressed") setActiveMic(true);
      else if (event.state === "Released") setActiveMic(false);
    })
      .then(() => {
        registered = true;
        // Cleanup ran before registration resolved — unregister now, otherwise
        // the OS-global shortcut stays captured with the setting off.
        if (cancelled) void unregister(PTT_SHORTCUT).catch(() => {});
      })
      .catch((err) => {
        console.warn("failed to register push-to-talk shortcut", err);
        toast.warning(
          "Push-to-talk unavailable",
          "Your OS or desktop environment blocked the global shortcut. Mic will only toggle from in-app controls." +
            (isMacOS() ? MACOS_QUARANTINE_HINT : ""),
        );
      });

    return () => {
      cancelled = true;
      if (registered) void unregister(PTT_SHORTCUT).catch(() => {});
    };
  }, [pushToTalk]);
}
