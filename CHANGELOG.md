# Changelog

All notable changes to Colloquium are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Section headers must match the release tag (`vX.Y.Z`) or bare version
(`X.Y.Z`) so the release workflow can pull the matching section into the
GitHub Release notes.

## Unreleased

### Added

- **Rooms have topics.** The column was always there and always gossiped with
  every announce; it just had nowhere to be typed. Set one from the space
  details, and it sits beside the room name in the header.
- **Export a conversation** to a Markdown file, grouped by day. Deleted messages
  are kept as a placeholder rather than dropped, so the record doesn't imply a
  conversation without gaps.
- **↑ in an empty composer edits your last message**, the way every other chat
  app does it.
- **Copy a message's text** from its hover toolbar — copying what the bubble
  reads as, so mentions and animated emoji don't paste as raw tokens.
- **A jump-to-latest pill** when you've scrolled away from the newest message,
  counting what arrived while you were reading back.
- **Attachment progress.** A 25 MB file takes real seconds to send and the
  composer used to simply look stuck.
- **Recently-used emoji** at the top of the picker.
- **Pause notifications** for 30 minutes, an hour, or eight. The sidebar says so
  while it's on, and that banner is also how you turn it back off.
- **Interface scale**, with ⌘+ / ⌘− / ⌘0.
- **⌘/ lists the keyboard shortcuts.**

- **Attachments catch up.** A file only ever streamed to whoever was online when
  it was sent, so anyone offline received the message with nothing behind it —
  permanently. A missing attachment now offers to fetch itself from the sender,
  and arrives in place. Only the author serves the bytes, only for a file one of
  their live messages actually references, and only to someone already entitled
  to that room.
- **Drafts survive quitting.** Half-written messages lived only in memory, so
  closing the window discarded them without a word. They are now kept per room
  and restored on the next launch.
- **⌘K jumps to people and rooms**, not just messages. Matching conversations
  appear above the message hits and open on Enter.

### Fixed

- **Messages could be lost for good.** The room-sync `have` vector reported the
  highest sequence number held per author, which hides a gap — and a peer told
  we already held a message never resent it. Anything in the hole was gone. The
  vector now reports the highest *contiguous* sequence. This is not an exotic
  case: a live send lands the moment its author reconnects, which easily beats
  the sync response carrying the middle.
- **Large attachments never arrived.** The receiving side rejected any file in
  roughly the top 4 KB of the 25 MB range the composer accepts. The message
  showed up, the file silently did not.
- **Push-to-talk left the microphone open.** With push-to-talk on, a call
  transmitted from the moment it connected until the shortcut was pressed for
  the first time — the exact opposite of what the setting means. Calls now open
  muted.
- Rooms no longer show phantom unread after reconnecting. A backfill routinely
  carries messages older than your read cursor, and each one was counted.
- A contact can no longer write a name, topic, or their own membership onto one
  of your direct-message rooms. Those room ids are derived from their two
  members, so they are guessable by design; group announcements are now confined
  to the group namespace.

## 0.6.0

### Added

- **The party outlives its host.** If whoever is controlling playback goes quiet
  — closed the app, lost their connection — the remaining viewers elect a new
  controller among themselves and the film carries on. No server decides this:
  every peer runs the same election over the same member list and reaches the
  same answer, so there is nothing to negotiate.
- Who is speaking is now shown on the watch party's presence row, so you can
  follow the conversation without opening the call window.

### Changed

- A room stops offering "Join watch party" for a party whose host vanished
  without ending it. Announcements now decay unless something renews them.
- The priming overlay counts each viewer against its own target. A peer playing
  the file directly needs about ten seconds of lead; one remuxing needs a
  minute. Both used to be reported against the minute.
- Party membership leases are stamped from the clock of the machine receiving
  them rather than the one sending them, so a peer whose clock runs fast can no
  longer hold the play gate open indefinitely.
- **Watch party peers must both be on 0.6.0.** The control messages changed
  shape, and a 0.5.1 peer in the party will block the start gate for everyone.

### Fixed

- A viewer who joined a room while a party was already running, and missed the
  announcement, opened a party of its own that silently took over the live one —
  party ids were derived from the room, so every party in a room was
  indistinguishable from every other. Ids are now unique per party, and when two
  do exist in one room every peer resolves it identically: the earlier start
  wins, and the loser is told which party to join.
- Any participant could end the watch party for everyone. Only the host or the
  peer currently controlling playback can now.
- Watch party control messages were attributed to whoever they claimed to be
  from rather than to the authenticated peer that sent them. Taking control,
  changing the film and ending the party could all be spoofed by any contact who
  could open a connection.
- A rival party's announcement could overwrite the live one, so pressing "Join
  watch party" put you into a party nobody was watching.
- A peer watching something else in the same room counted toward the readiness
  gate, holding the start back for everyone.
- The election could pick the very peer it had just declared silent, costing
  another ten seconds before anyone actually took over.
- Pong replies from any peer, not just the one being timed, skewed the clock
  estimate that keeps every follower on the same frame.
- A follower acted on the first out-of-range position it saw while paused, which
  could jump the whole party to the start of the film.
- Pointing the party at a different file left followers steering by a position
  measured in the previous one.
- Unsolicited subtitle messages added duplicate tracks to the menu.
- A single lost camera-state message left a participant's tile showing an avatar
  until they toggled their camera by hand. Camera state now travels with the
  presence reply and repeats on the beacon, so a newcomer or a reconnected peer
  learns it without waiting.
- The watch party's camera rail hid live video behind an avatar whenever it had
  not yet heard a participant's camera state.
- A camera tile hidden behind the rail stayed frozen when the rail came back, on
  macOS and iOS webviews that reclaim the decoder of a hidden video element.
- Starting and joining a party at the same moment could leave the losing attempt
  to finish and install a session that had already been torn down.
- Anyone added to a room while a party was running never heard from it at all.

## 0.5.1

### Fixed

- Watch party playback failed to start on Windows with a missing-entry-point
  error from `libwinpthread-1.dll`. The bundled ffmpeg sidecars now link their
  toolchain runtime statically instead of depending on whatever copy happens to
  be on `PATH`.
- Windows HLS output wrote `init.mp4` to the wrong directory, so the playlist
  loaded but every fragment 404'd and playback stalled on a fragment-load error.

## 0.5.0

### Added

- **Watch party playback.** Paste a video URL and watch it together, in sync,
  with everyone's camera and mic alongside it. Every peer fetches the same
  source itself — only small control messages cross the P2P link, never media
  bytes.
- Real movie files now play: MKV and other containers the webview cannot open,
  HEVC, AC3/E-AC3/DTS/TrueHD audio, multiple audio tracks, and embedded
  subtitles. A bundled ffmpeg sidecar remuxes or transcodes to HLS on the fly.
  Nothing to install — the sidecars ship with the app.
- What each machine has to do is decided by asking that machine, not by guessing
  from its operating system. A Mac decodes HEVC natively and only remuxes; a
  Windows PC without the HEVC Video Extension transcodes the same file. Both
  stay in sync frame-for-frame, because positions are tracked on the source
  timeline rather than on whatever each peer's pipeline produced.
- Audio-track and subtitle selection follow the controller. Subtitle track
  changes and subtitle delay apply instantly on every peer with no rebuffering.
  External `.srt`, `.ass`/`.ssa` and `.vtt` files can be shared into the party.
  Image-based subtitles (PGS, VOBSUB) are listed but greyed out — they cannot be
  converted to WebVTT.

### Fixed

- Watch party video was blocked outright by the content-security policy, so no
  remote source could ever play.
- Playback errors and autoplay blocking are surfaced on the video stage instead
  of failing silently to a black screen.
- Subtitle files larger than a few dozen kilobytes overflowed the call stack
  when shared with the party.
- External subtitle files were attached as `text/plain`, which no engine parses
  as captions.

### Removed

- **Linux builds.** Colloquium now ships for macOS and Windows only. The `.deb`,
  `.rpm` and `.AppImage` targets, the Secret Service keyring backend and the
  Linux CI matrix are gone.
- The transparent-window and macOS private-API flags, which existed only for the
  deleted native video overlay.

## 0.4.0

### Changed

- Rebranded from Haven to Colloquium. The bundle identifier changed from
  `havenapp` to `colloquiumapp` and the local database from `haven.db` to
  `colloquium.db`, so existing installs start fresh (new identity key and
  local database). On macOS, run `scripts/cleanup-old-identifier-macos.sh` to
  remove all traces of an old install before upgrading.
- New atmospheric-midnight visual system: deep indigo canvas, luminous amber
  accent, and restructured onboarding, sidebar, and settings surfaces.

## 0.3.0

### Changed

- Renamed the bundle identifier from `care.ayoo.haven` to `havenapp`. Existing
  installs start fresh (new identity key and local database) since the app
  data directory and keychain entry derive from the identifier. On macOS, run
  `scripts/cleanup-old-identifier-macos.sh` to remove all traces of an old
  install before upgrading.

### Fixed

- `fix-macos-permissions.sh` now resets stale macOS permission records after
  re-signing. Previously, grants recorded under the old signature no longer
  matched and macOS silently denied mic/camera/screen access without ever
  re-prompting, so calls failed after running the script. It also reads the
  bundle identifier from the installed app instead of hard-coding it.

## 0.2.0

### Security

- Added a sender-authentication chokepoint so only trusted contacts' P2P
  traffic is processed (outside the invite/friend handshake).
- Stopped leaking the full roster to strangers on connect.
- Closed DM message forgery and DM history exfiltration holes (room ids are
  publicly derivable).
- `room_leave` must now come from the leaver; file-chunk size/index are now
  bounded.

### Fixed

**Calls**
- Fixed a macOS bug where a friend's screen share echoed your own mic back to
  you: system-audio capture now excludes Colloquium's application — including the
  WKWebView helper processes that actually render call audio — at the
  ScreenCaptureKit filter level, not just the capturing process itself.
- Fixed switching microphones mid-call sometimes replacing the wrong sender's
  track (the screen-share audio sender instead of the mic), which could
  swap or garble the audio the other side heard.
- Fixed screen shares not appearing during 1:1 video calls — the receiver
  merged the remote camera and screen tracks into a single stream, but a
  `<video>` element only ever plays a stream's first video track.
- Fixed a `startCall`/`joinRoomCall` TOCTOU race, a replayable `call_accept`
  peer leak, a system-audio stop/start race, and several screen-share track
  leaks and missing guards.
- Fixed a stale mic-flag snapshot and an RNNoise cached-rejection bug.

**macOS**
- TCC (permission) grants no longer reset on every dev rebuild or release
  build: dev builds are now signed with a stable self-signed identity, and
  release builds are ad-hoc signed so Screen Recording/Accessibility grants
  persist across launches after un-quarantine.

**Rust backend**
- Fixed a system-audio double-start race, a Windows COM lifetime/init
  imbalance, and an audio-buffer alignment UB.

**Data & load**
- Fixed a message-vanish race during load/ingest, a direction-blind
  friend-request lookup that dropped acceptances on mutual requests, and a
  clock-skew read cursor bug causing phantom unread counts.

**UI**
- Fixed a stale `activeRoomId`, a push-to-talk shortcut leak, a focus trap
  attached to `document` instead of the modal, doubled audio on video-tile
  remount, autoscroll not working for tall messages, modal form state not
  resetting, and incorrect unread counts across a batched backfill.

### Changed

- Removed dead code, exports, props, the unused opener plugin, and unused
  dependencies; consolidated the quality-dot table.
- Batched sync-backfill ingest and added equality guards to cut re-renders.

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
