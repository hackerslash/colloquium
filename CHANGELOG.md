# Changelog

All notable changes to Haven are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Section headers must match the release tag (`vX.Y.Z`) or bare version
(`X.Y.Z`) so the release workflow can pull the matching section into the
GitHub Release notes.

## 0.1.0

### Added

- Screen-share quality settings, including a link-tested Max mode with live
  bitrate probing and A/V sync fixes for shared audio.
- Native macOS system-audio capture for screen sharing (ScreenCaptureKit),
  since WKWebView can't expose display audio itself.
- Voice isolation and noise-suppression settings, applied live to ongoing
  calls.
- Display name editing from Settings.
- A synthesized ringtone and a top-level error boundary.
- CI now builds and tests natively on macOS, Windows, and Linux on every
  push/PR, including a real D-Bus secret-service session on Linux, so
  platform-specific regressions are caught before release.

### Changed

- Full UI redesign ("luxury soft" visual system) across app and onboarding.
- Real Content-Security-Policy in place of the default.
- Linux is now a fully supported platform, not just a build target: the
  identity keychain uses the Secret Service D-Bus API (GNOME Keyring/KWallet)
  instead of silently falling back to a non-persistent in-memory store.

### Fixed

This release closes a broad set of reliability gaps found in a systematic
audit across the networking/call layer, the local data layer, the Rust
backend, and the frontend stores/components.

**Calls**
- Fixed crash-and-resource-leak bugs where an in-progress call's context was
  read before an `await` (a permission prompt or OS picker) and used
  afterward without checking it was still current — affected accepting a
  call, starting/stopping screen share, and toggling the camera, in both
  1:1 and room calls. Previously this could crash and leave the mic, camera,
  or screen capture open after the call had already ended.
- Room calls: a participant whose media connection died while their
  signaling channel kept sending beacons was never removed, leaving a
  permanently frozen tile. Now reaped via an independent media-liveness
  timer.
- The PeerJS signaling broker dying from a fatal error (not just a plain
  disconnect) left the app unreachable until restart; it now recovers the
  same way a plain disconnect does.
- Fixed a presenter-slot heartbeat tie-break gap that could flip a
  screen-share slot to the wrong holder after a glare.
- Messages from the same peer are now handled strictly in arrival order, so
  concurrent SDP messages can no longer interleave and drop a renegotiation.
- ICE candidates that arrive before the remote session description are now
  queued and applied once it lands, instead of being silently dropped.
- Fixed several handlers in the network message router that could fail
  silently (unhandled rejections) instead of surfacing the error.
- Fixed mic/camera permission failures not being surfaced to the user, and
  an authorization gap that let non-members send room-call signaling.

**Data**
- Closed a data-loss race where two rapid sends could silently drop the
  second message (a unique-constraint conflict that was ignored).
- A received file's in-memory buffer is now only discarded after it's
  durably stored, instead of before.
- Reordered invite consumption so a crash mid-sequence can't burn the
  invite token without ever adding the contact.
- The roster upsert is now a single atomic statement instead of a
  read-then-branch that could race.
- Added a DB-level constraint preventing duplicate pending friend requests
  from a race or a double-clicked "Add friend".
- Blocked repeat friend requests after a decline.

**Rust backend**
- A missing default window icon no longer panics the app at startup.
- Corrupted or wrong-length stored key data now self-heals (regenerates a
  fresh identity) instead of permanently locking onboarding.
- Fixed a mutex held across an FFI call in the system-audio stop path.
- System-audio capture setup now runs off the main thread, so a slow
  first-run permission prompt can no longer freeze the window.
- Tray icon creation is now non-fatal, so desktops without a tray host
  (common on some Linux setups) don't crash the whole app at launch.

**Frontend**
- Fixed a modal focus trap that re-stole focus on every unrelated
  background re-render, disrupting mid-typing.
- Incoming-call ringtones could play completely silently if the audio
  context started suspended (autoplay policy) — it's now explicitly
  resumed.
- Fixed stale-response races when switching rooms or reopening the members
  list quickly.
- Added in-flight guards against double-send and double-accept/decline.
- Settings writes now roll back (and notify) on a failed save instead of
  leaving a value that never actually persisted.
- Notification-permission denial is no longer cached forever; a later grant
  (or the current denial) is now surfaced instead of silently assumed.
- Widened the HLC counter so sustained clock skew can no longer overflow it
  and silently reorder messages.
- Wired up the `closeToTray` setting and gated it on the tray actually
  existing, so it can't strand a hidden window with no way to reopen it.
