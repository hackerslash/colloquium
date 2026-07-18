import type { Identity, RosterContact } from "../../types/domain";
import type { AvatarDataMessage, ProfileAnnounceMessage } from "../../types/wire";
import * as avatarRepo from "../db/avatarRepo";
import { getPeerRegistry } from "../peer/registry";
import { derivePeerId } from "../peer/derivePeerId";
import { sha256Hex } from "../../lib/crypto";
import { base64ToBytes, bytesToBase64 } from "../../lib/base64";
import { useRosterStore } from "../../stores/useRosterStore";
import { useAvatarStore } from "../../stores/useAvatarStore";

const AVATAR_DIM = 256;
export const MAX_AVATAR_BYTES = 64 * 1024;
const AVATAR_MIME = "image/jpeg";

/** Cover-crops the image to a centered AVATAR_DIM square and re-encodes it as
 * JPEG, stepping quality down until it fits under the byte cap. Throws on an
 * undecodable file or one that can't be squeezed under the cap. */
export async function processImageFile(
  file: File,
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("Unsupported or corrupt image"));
      el.src = url;
    });

    const canvas = document.createElement("canvas");
    canvas.width = AVATAR_DIM;
    canvas.height = AVATAR_DIM;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas not available");

    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const sx = (img.naturalWidth - side) / 2;
    const sy = (img.naturalHeight - side) / 2;
    ctx.drawImage(img, sx, sy, side, side, 0, 0, AVATAR_DIM, AVATAR_DIM);

    for (const quality of [0.85, 0.7, 0.6, 0.5]) {
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, AVATAR_MIME, quality),
      );
      if (!blob) continue;
      if (blob.size <= MAX_AVATAR_BYTES) {
        return { bytes: new Uint8Array(await blob.arrayBuffer()), mimeType: AVATAR_MIME };
      }
    }
    throw new Error("Image too large after compression");
  } finally {
    URL.revokeObjectURL(url);
  }
}

function connectedContacts(): RosterContact[] {
  const registry = getPeerRegistry();
  return Object.values(useRosterStore.getState().contactsById).filter(
    (c) => !c.revoked && registry.isConnected(derivePeerId(c.identityId)),
  );
}

function broadcastProfile(msg: ProfileAnnounceMessage): void {
  const registry = getPeerRegistry();
  for (const c of connectedContacts()) {
    registry.send(derivePeerId(c.identityId), msg);
  }
}

export async function setSelfAvatar(self: Identity, file: File): Promise<void> {
  const { bytes, mimeType } = await processImageFile(file);
  const hash = await sha256Hex(bytes);
  const updatedAt = Date.now();
  await avatarRepo.upsertAvatar({ identityId: self.identityId, hash, mimeType, data: bytes, updatedAt });
  useAvatarStore.getState().applyAvatar(self.identityId, { mimeType, data: bytes });
  broadcastProfile({ type: "profile_announce", avatarHash: hash, updatedAt });
}

export async function clearSelfAvatar(self: Identity): Promise<void> {
  await avatarRepo.deleteAvatar(self.identityId);
  useAvatarStore.getState().applyAvatar(self.identityId, null);
  broadcastProfile({ type: "profile_announce", avatarHash: null, updatedAt: Date.now() });
}

/** Tells a freshly-connected peer our current avatar hash so they can pull it
 * if theirs is stale (or drop theirs if we've cleared ours). */
export async function announceProfileTo(self: Identity, toPeerId: string): Promise<void> {
  const meta = await avatarRepo.getAvatarMeta(self.identityId);
  getPeerRegistry().send(toPeerId, {
    type: "profile_announce",
    avatarHash: meta?.hash ?? null,
    updatedAt: meta?.updatedAt ?? 0,
  } satisfies ProfileAnnounceMessage);
}

export async function handleProfileAnnounce(
  sender: RosterContact,
  fromPeerId: string,
  msg: ProfileAnnounceMessage,
): Promise<void> {
  const stored = await avatarRepo.getAvatarMeta(sender.identityId);
  const storedHash = stored?.hash ?? null;
  if (msg.avatarHash === storedHash) return;

  if (msg.avatarHash === null) {
    await avatarRepo.deleteAvatar(sender.identityId);
    useAvatarStore.getState().applyAvatar(sender.identityId, null);
    return;
  }
  getPeerRegistry().send(fromPeerId, { type: "avatar_request" });
}

export async function handleAvatarRequest(self: Identity, fromPeerId: string): Promise<void> {
  const rec = await avatarRepo.getAvatar(self.identityId);
  const registry = getPeerRegistry();
  if (!rec) {
    // We were asked but have nothing — correct the requester's view.
    registry.send(fromPeerId, {
      type: "profile_announce",
      avatarHash: null,
      updatedAt: Date.now(),
    } satisfies ProfileAnnounceMessage);
    return;
  }
  registry.send(fromPeerId, {
    type: "avatar_data",
    hash: rec.hash,
    mimeType: rec.mimeType,
    updatedAt: rec.updatedAt,
    data: bytesToBase64(rec.data),
  } satisfies AvatarDataMessage);
}

export async function handleAvatarData(
  sender: RosterContact,
  msg: AvatarDataMessage,
): Promise<void> {
  // Cheap length gate before decoding, so an oversized payload never allocates.
  if (msg.data.length > Math.ceil((MAX_AVATAR_BYTES * 4) / 3) + 4) return;
  const bytes = base64ToBytes(msg.data);
  if (bytes.length > MAX_AVATAR_BYTES) return;
  if ((await sha256Hex(bytes)) !== msg.hash) {
    console.warn("dropping avatar_data with mismatched hash from", sender.identityId);
    return;
  }
  const stored = await avatarRepo.getAvatarMeta(sender.identityId);
  if (stored && msg.updatedAt < stored.updatedAt) return;

  await avatarRepo.upsertAvatar({
    identityId: sender.identityId,
    hash: msg.hash,
    mimeType: msg.mimeType,
    data: bytes,
    updatedAt: msg.updatedAt,
  });
  useAvatarStore.getState().applyAvatar(sender.identityId, { mimeType: msg.mimeType, data: bytes });
}
