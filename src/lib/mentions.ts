/**
 * @-mention encoding. A mention is stored inline in the message body as a
 * markdown-link-shaped token `@[DisplayName](identityId)`:
 *
 *   - identityId is the authoritative target (display names are not unique);
 *     the embedded name is only a fallback label for clients/senders that
 *     don't (yet) have that contact in their roster.
 *   - The token lives inside the signed body, so mentions need no wire change.
 *   - Rendering resolves the id to the viewer's own roster name when known.
 *
 * identityId is a hex SHA-256 digest (see derive_identity_id in identity.rs),
 * hence the `[A-Za-z0-9_-]` id class; the `{8,128}` bound is deliberately loose
 * so the format survives future id schemes without a token migration.
 */
export const MENTION_RE = /@\[([^\]\n]{1,64})\]\(([A-Za-z0-9_-]{8,128})\)/g;

/** Builds a mention token, sanitizing the display name so it can't break the
 * token grammar (`]` and newlines would terminate the name group early). */
export function mentionToken(name: string, identityId: string): string {
  const safe = name.replace(/[\]\n]/g, "").slice(0, 64).trim() || "user";
  return `@[${safe}](${identityId})`;
}

/** The set of identityIds mentioned anywhere in a message body. */
export function mentionedIds(body: string | null): Set<string> {
  const ids = new Set<string>();
  if (!body) return ids;
  // Fresh regex each call: MENTION_RE is global (stateful lastIndex).
  const re = new RegExp(MENTION_RE.source, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) ids.add(match[2]);
  return ids;
}

/** Whether a message body mentions the given identity. */
export function mentionsIdentity(body: string | null, identityId: string): boolean {
  if (!body || !identityId) return false;
  const re = new RegExp(MENTION_RE.source, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    if (match[2] === identityId) return true;
  }
  return false;
}

/** Replaces mention tokens with a plain `@Name` label — for notification
 * bodies, reply snippets, and search snippets where a raw token would leak the
 * id and read as noise. */
export function humanizeMentions(body: string): string {
  return body.replace(new RegExp(MENTION_RE.source, "g"), (_full, name: string) => `@${name}`);
}
