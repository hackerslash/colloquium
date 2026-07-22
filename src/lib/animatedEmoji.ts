/**
 * Built-in animated emoji. Unlike @mentions (mentions.ts) these carry no
 * external reference — a token `:fx:<id>:` is a fixed key into ANIMATED_EMOJI
 * below, resolved locally from bundled assets (src/assets/emoji-animated/,
 * see scripts/fetch-animated-emoji.sh and its NOTICE.md for provenance).
 * The token can be embedded directly in a message body or stored as a
 * reaction's `emoji` string exactly like a plain Unicode glyph — both fields
 * are already unconstrained strings, so this needs no wire/DB change (see
 * mentions.ts for the same reasoning applied to `@[Name](id)`).
 *
 * id grammar is deliberately narrow (lowercase kebab-case, short) so the
 * whole token comfortably clears MAX_REACTION_EMOJI_LEN (32) in
 * chatService.ts and can't be confused with mention/markdown syntax — no
 * existing inline syntax (mentions, code spans, bold/italic/strikethrough,
 * links) uses a bare `:`.
 */
export const ANIMATED_EMOJI_RE = /:fx:([a-z0-9-]{1,24}):/g;

export type AnimatedEmojiDef = {
  id: string;
  name: string;
  keywords: string;
};

export const ANIMATED_EMOJI: AnimatedEmojiDef[] = [
  { id: "tada", name: "Party Popper", keywords: "tada party celebrate confetti congrats" },
  { id: "thumbs-up", name: "Thumbs Up", keywords: "thumbsup like yes agree +1 good" },
  { id: "thumbs-down", name: "Thumbs Down", keywords: "thumbsdown dislike no -1 bad" },
  { id: "clap", name: "Clapping Hands", keywords: "clap applause bravo well done" },
  { id: "heart", name: "Red Heart", keywords: "heart love red" },
  { id: "heart-sparkle", name: "Sparkling Heart", keywords: "sparkling heart love cute" },
  { id: "two-hearts", name: "Two Hearts", keywords: "two hearts love affection" },
  { id: "heart-fire", name: "Heart on Fire", keywords: "heart fire passion love intense" },
  { id: "heart-beat", name: "Beating Heart", keywords: "beating heart pulse love" },
  { id: "heart-grow", name: "Growing Heart", keywords: "growing heart love touched" },
  { id: "joy", name: "Tears of Joy", keywords: "joy laugh lol haha funny" },
  { id: "sob", name: "Loudly Crying", keywords: "sob cry bawling sad" },
  { id: "cry", name: "Crying Face", keywords: "cry tear sad" },
  { id: "thinking", name: "Thinking Face", keywords: "thinking hmm consider" },
  { id: "fire", name: "Fire", keywords: "fire flame hot lit" },
  { id: "hundred", name: "Hundred Points", keywords: "100 hundred perfect score" },
  { id: "eyes", name: "Eyes", keywords: "eyes looking side-eye watching" },
  { id: "rocket", name: "Rocket", keywords: "rocket launch ship fast" },
  { id: "star-struck", name: "Star-Struck", keywords: "star struck wow amazed starstruck" },
  { id: "wow", name: "Wow Face", keywords: "wow surprised shocked open mouth" },
  { id: "pray", name: "Folded Hands", keywords: "pray please thanks thank you" },
  { id: "muscle", name: "Flexed Biceps", keywords: "muscle strong flex gym" },
  { id: "ok-hand", name: "OK Hand", keywords: "ok okay perfect" },
  { id: "wave", name: "Waving Hand", keywords: "wave hello hi bye goodbye" },
  { id: "grin", name: "Grinning Face", keywords: "grin happy smile" },
  { id: "wink", name: "Winking Face", keywords: "wink playful joke" },
  { id: "heart-eyes", name: "Heart Eyes", keywords: "heart eyes love adore crush" },
  { id: "blow-kiss", name: "Blowing a Kiss", keywords: "kiss blow love xoxo" },
  { id: "astonished", name: "Astonished Face", keywords: "astonished shocked surprised" },
  { id: "mind-blown", name: "Mind Blown", keywords: "mind blown exploding head shocked wow" },
  { id: "clown", name: "Clown Face", keywords: "clown silly joke honk" },
  { id: "skull", name: "Skull", keywords: "skull dead dying funny" },
  { id: "ghost", name: "Ghost", keywords: "ghost spooky boo" },
  { id: "sun", name: "Sun", keywords: "sun sunny bright day" },
  { id: "rainbow", name: "Rainbow", keywords: "rainbow pride colorful" },
  { id: "cake", name: "Birthday Cake", keywords: "cake birthday celebrate party" },
  { id: "nerd", name: "Nerd Face", keywords: "nerd geek glasses smart" },
  { id: "tongue", name: "Tongue Out", keywords: "tongue silly playful" },
  { id: "angry", name: "Angry Face", keywords: "angry mad rage annoyed" },
  { id: "pleading", name: "Pleading Face", keywords: "pleading puppy eyes beg please" },
  { id: "sunglasses", name: "Cool Sunglasses", keywords: "cool sunglasses swag" },
  { id: "sleepy", name: "Zzz", keywords: "sleepy tired zzz sleeping" },
  { id: "see-no-evil", name: "See-No-Evil Monkey", keywords: "see no evil monkey awkward oops" },
  { id: "hear-no-evil", name: "Hear-No-Evil Monkey", keywords: "hear no evil monkey" },
  { id: "speak-no-evil", name: "Speak-No-Evil Monkey", keywords: "speak no evil monkey secret quiet" },
  { id: "dog", name: "Dog Face", keywords: "dog puppy cute" },
  { id: "cat", name: "Cat Face", keywords: "cat kitten cute meow" },
  { id: "money-face", name: "Money-Mouth Face", keywords: "money rich cash greedy" },
  { id: "monocle", name: "Monocle Face", keywords: "monocle suspicious inspecting curious" },
  { id: "robot", name: "Robot", keywords: "robot bot ai" },
  { id: "hug", name: "Hugging Face", keywords: "hug hugs love care" },
  { id: "kiss", name: "Kissing Face", keywords: "kiss love smooch" },
  { id: "party-face", name: "Partying Face", keywords: "party celebrate birthday hooray" },
  { id: "smirk", name: "Smirking Face", keywords: "smirk smug sly" },
  { id: "neutral", name: "Neutral Face", keywords: "neutral meh straight face" },
  { id: "frown", name: "Frowning Face", keywords: "frown sad disappointed" },
  { id: "weary", name: "Weary Face", keywords: "weary exhausted tired overwhelmed" },
  { id: "hushed", name: "Hushed Face", keywords: "hushed surprised quiet shock" },
  { id: "confounded", name: "Confounded Face", keywords: "confounded frustrated upset" },
  { id: "scream", name: "Screaming in Fear", keywords: "scream fear scared shocked" },
  { id: "vomit", name: "Vomiting Face", keywords: "vomit sick gross ill" },
  { id: "hot", name: "Hot Face", keywords: "hot sweating heat overwhelmed" },
  { id: "cold", name: "Cold Face", keywords: "cold freezing shivering" },
  { id: "zany", name: "Zany Face", keywords: "zany crazy wild goofy" },
  { id: "shush", name: "Shushing Face", keywords: "shush quiet secret hush" },
  { id: "gasp", name: "Gasping Face", keywords: "gasp shock surprise oops hand over mouth" },
  { id: "sneeze", name: "Sneezing Face", keywords: "sneeze sick cold achoo" },
  { id: "persevere", name: "Persevering Face", keywords: "persevere struggling determined" },
  { id: "worried", name: "Worried Face", keywords: "worried concerned anxious" },
  { id: "sleep", name: "Sleeping Face", keywords: "sleep sleeping zzz tired" },
];

const BY_ID = new Map(ANIMATED_EMOJI.map((e) => [e.id, e]));

export function animatedEmojiToken(id: string): string {
  return `:fx:${id}:`;
}

/** Parses a single `:fx:<id>:` token and resolves it to its definition, or
 * null if `s` isn't a well-formed token or the id isn't in the curated set
 * (e.g. a token from a client whose set has since changed). */
export function isAnimatedEmojiToken(s: string): AnimatedEmojiDef | null {
  const m = /^:fx:([a-z0-9-]{1,24}):$/.exec(s);
  return m ? (BY_ID.get(m[1]) ?? null) : null;
}

// Vite-native asset resolution: eager glob keeps this simple for a small,
// always-bundled set. This only resolves id -> hashed URL strings; image
// bytes are fetched by the browser lazily when an <img> using that URL
// actually renders.
const assetModules = import.meta.glob("../assets/emoji-animated/*.webp", {
  eager: true,
  import: "default",
}) as Record<string, string>;

export function resolveAnimatedEmojiUrl(id: string): string | null {
  return assetModules[`../assets/emoji-animated/${id}.webp`] ?? null;
}

const posterCache = new Map<string, string>();
const posterInFlight = new Map<string, Promise<string | null>>();

export async function getAnimatedEmojiPoster(id: string): Promise<string | null> {
  const cached = posterCache.get(id);
  if (cached) return cached;
  const existing = posterInFlight.get(id);
  if (existing) return existing;

  const url = resolveAnimatedEmojiUrl(id);
  if (!url || typeof createImageBitmap !== "function" || typeof document === "undefined") {
    return null;
  }

  const p = (async (): Promise<string | null> => {
    try {
      const blob = await (await fetch(url)).blob();
      const bitmap = await createImageBitmap(blob);
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      const dataUrl = canvas.toDataURL("image/png");
      posterCache.set(id, dataUrl);
      return dataUrl;
    } catch {
      return null;
    } finally {
      posterInFlight.delete(id);
    }
  })();

  posterInFlight.set(id, p);
  return p;
}

export type ResolvedEmoji =
  | { kind: "glyph"; glyph: string }
  | { kind: "animated"; url: string; name: string };

/** Resolves a raw reaction/token string to either a plain Unicode glyph or
 * an animated emoji's asset URL — the single place MessageList's reaction
 * pills and MarkdownRenderer's inline rendering both branch on, so neither
 * duplicates the token-parsing logic. */
export function resolveEmoji(raw: string): ResolvedEmoji {
  const def = isAnimatedEmojiToken(raw);
  const url = def && resolveAnimatedEmojiUrl(def.id);
  return def && url ? { kind: "animated", url, name: def.name } : { kind: "glyph", glyph: raw };
}

/** Maximum animated emoji in a message for the bubble-less "jumbo" treatment
 * (see jumboAnimatedEmojiIds) — matches the WhatsApp/Telegram convention of
 * capping emoji-only messages at a handful before falling back to a normal
 * bubble. */
const MAX_JUMBO_EMOJI = 3;

/** If `body` consists of nothing but 1-3 animated emoji tokens (only
 * whitespace between/around them), returns their ids in order — signaling
 * the message should render bubble-less and larger, like a sticker. Returns
 * null for mixed text+emoji bodies, plain-text/glyph-only bodies, unknown
 * token ids, or more than MAX_JUMBO_EMOJI tokens (falls back to a normal
 * bubble in that case). */
export function jumboAnimatedEmojiIds(body: string | null): string[] | null {
  if (!body || !body.trim()) return null;
  const stripped = body.replace(new RegExp(ANIMATED_EMOJI_RE.source, "g"), "").trim();
  if (stripped.length > 0) return null;
  const ids = [...body.matchAll(new RegExp(ANIMATED_EMOJI_RE.source, "g"))].map((m) => m[1]);
  if (ids.length === 0 || ids.length > MAX_JUMBO_EMOJI) return null;
  if (!ids.every((id) => BY_ID.has(id))) return null;
  return ids;
}

/** Replaces animated emoji tokens with a readable `[Name]` label — for
 * notification bodies, reply snippets, and search snippets where a raw
 * token would just show as literal `:fx:id:` text. Mirrors
 * humanizeMentions in mentions.ts. */
export function humanizeAnimatedEmoji(text: string): string {
  return text.replace(new RegExp(ANIMATED_EMOJI_RE.source, "g"), (full, id: string) => {
    const def = BY_ID.get(id);
    return def ? `[${def.name}]` : full;
  });
}
