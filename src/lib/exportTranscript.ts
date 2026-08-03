import type { Message } from "../types/domain";
import { humanizeMentions } from "./mentions";
import { humanizeAnimatedEmoji } from "./animatedEmoji";

/** Readable form of a message body: mention and animated-emoji tokens become
 * `@Name` / `[Party Popper]` rather than leaking their wire syntax. */
function readableBody(body: string): string {
  return humanizeAnimatedEmoji(humanizeMentions(body));
}

function dayHeading(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function timeOf(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** Filesystem-safe slug for the download name. */
function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "conversation"
  );
}

/** Renders a room's history as Markdown, grouped under day headings. Tombstones
 * are kept as a placeholder rather than dropped, so the record doesn't silently
 * imply a conversation that never had gaps. */
export function buildTranscript(
  title: string,
  messages: Message[],
  nameOf: (authorId: string) => string,
  exportedAt: number,
): string {
  const lines: string[] = [`# ${title}`, "", `Exported ${new Date(exportedAt).toLocaleString()}`, ""];
  let lastDay = "";

  for (const m of messages) {
    const day = dayHeading(m.sentAt);
    if (day !== lastDay) {
      lines.push(`## ${day}`, "");
      lastDay = day;
    }

    lines.push(`**${nameOf(m.authorId)}** · ${timeOf(m.sentAt)}${m.editedAt ? " (edited)" : ""}`);
    if (m.deletedAt) {
      lines.push("", "*message deleted*", "");
      continue;
    }
    lines.push("");
    if (m.body) lines.push(readableBody(m.body), "");
    if (m.attachmentName) lines.push(`📎 ${m.attachmentName}`, "");
  }

  if (messages.length === 0) lines.push("*No messages.*", "");
  return lines.join("\n");
}

/** Saves the transcript through the browser's download path — the same
 * mechanism attachments already use, so it needs no extra Tauri permission. */
export function downloadTranscript(title: string, markdown: string, exportedAt: number): void {
  const stamp = new Date(exportedAt).toISOString().slice(0, 10);
  const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `colloquium-${slugify(title)}-${stamp}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
