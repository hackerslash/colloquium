import { useEffect, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { motion } from "motion/react";
import { ANIMATED_EMOJI, animatedEmojiToken, resolveAnimatedEmojiUrl } from "../../lib/animatedEmoji";

type EmojiCategory = {
  id: string;
  name: string;
  icon: string;
  emojis: string[];
};

const EMOJI_CATEGORIES: EmojiCategory[] = [
  {
    id: "smileys",
    name: "Smileys & Emotion",
    icon: "😀",
    emojis: [
      "😀", "😃", "😄", "😁", "😆", "😅", "😂", "🤣", "😊", "😇",
      "🙂", "🙃", "😉", "😌", "😍", "🥰", "😘", "😗", "😙", "😚",
      "😋", "😛", "😝", "😜", "🤪", "🤨", "🧐", "🤓", "😎", "🥸",
      "🤩", "🥳", "😏", "😒", "😞", "😔", "😟", "😕", "🙁", "😣",
      "😖", "😫", "😩", "🥺", "😢", "😭", "😤", "😠", "😡", "🤬",
      "🤯", "😳", "🥵", "🥶", "😱", "😨", "😰", "😥", "😓", "🤗",
      "🤔", "🫣", "🤭", "🫢", "🫡", "🤫", "🫠", "🤥", "😶", "😐",
      "😑", "😬", "🙄", "😯", "😦", "😧", "😮", "😲", "🥱", "😴",
      "🤤", "😪", "😵", "😵‍💫", "🤐", "🥴", "🤢", "🤮", "🤧", "😷",
      "🤒", "🤕", "🤑", "🤠", "😈", "👿", "💀", "☠️", "💩", "🤡",
      "👹", "👺", "👻", "👽", "👾", "🤖", "🎃", "😺", "😸", "😹",
    ],
  },
  {
    id: "people",
    name: "People & Gestures",
    icon: "👋",
    emojis: [
      "👋", "🤚", "🖐", "✋", "🖖", "🫱", "🫲", "🫳", "🫴", "👌",
      "🤌", "🤏", "✌️", "🤞", "🫰", "🤟", "🤘", "🤙", "👈", "👉",
      "👆", "🖕", "👇", "☝️", "👍", "👎", "✊", "👊", "🤛", "🤜",
      "👏", "🙌", "🫶", "👐", "🤲", "🤝", "🙏", "✍️", "💅", "🤳",
      "💪", "🦾", "🦿", "🦵", "🦶", "👂", "🦻", "👃", "🧠", "🫀",
      "🫁", "🦷", "🦴", "👀", "👁️", "👅", "👄", "🫦", "👶", "🧒",
      "👦", "👧", "🧑", "👱", "👨", "🧔", "👩", "🧓", "👴", "👵",
    ],
  },
  {
    id: "animals",
    name: "Animals & Nature",
    icon: "🐶",
    emojis: [
      "🐶", "🐱", "🐭", "🐹", "🐰", "🦊", "🐻", "🐼", "🐻‍❄️", "🐨",
      "🐯", "🦁", "🐮", "🐷", "🐸", "🐵", "🙈", "🙉", "🙊", "🐒",
      "🐔", "🐧", "🐦", "🐤", "🐣", "🐥", "🦆", "🦅", "🦉", "🦇",
      "🐺", "🐗", "🐴", "🦄", "🐝", "🪱", "🐛", "🦋", "🐌", "🐞",
      "🐜", "🪰", "🪲", "🪳", "🦟", "🦗", "🕷", "🕸", "🦂", "🐢",
      "🐍", "🦎", "🦖", "🦕", "🐙", "🦑", "🦐", "🦞", "🦀", "🐡",
      "🐠", "🐟", "🐬", "🐳", "🐋", "🦈", "🦭", "🐊", "🐅", "🐆",
      "🌱", "🌿", "☘️", "🍀", "🎍", "🪴", "🎍", "🍃", "🍂", "🍁",
      "🍄", "🌾", "💐", "🌷", "🌹", "🥀", "🌺", "🌸", "🌼", "🌻",
      "🌞", "🌝", "⭐️", "🌟", "✨", "⚡️", "💥", "🔥", "🌈", "☀️",
    ],
  },
  {
    id: "food",
    name: "Food & Drink",
    icon: "🍕",
    emojis: [
      "🍏", "🍎", "🍐", "🍊", "🍋", "🍌", "🍉", "🍇", "🍓", "🫐",
      "🍈", "🍒", "🍑", "🥭", "🍍", "🥥", "🥝", "🍅", "🍆", "🥑",
      "🥦", "🥬", "🥒", "🌶️", "🫑", "🌽", "🥕", "🫒", "🧄", "🧅",
      "🥔", "🍠", "🥐", "🥯", "🍞", "🥖", "🥨", "🧀", "🥚", "🍳",
      "🧈", "🥞", "🧇", "🥓", "🥩", "🍗", "🍖", "🌭", "🍔", "🍟",
      "🍕", "🫓", "🥪", "🥙", "🧆", "🌮", "🌯", "🫔", "🥗", "🥘",
      "🫕", "🥫", "🍝", "🍜", "🍲", "🍛", "🍣", "🍱", "🥟", "🦪",
      "🍤", "🍙", "🍚", "🍘", "🍥", "🥠", "🥮", "🍢", "🍡", "🍧",
      "🍨", "🍦", "🥧", "🧁", "🍰", "🎂", "🍮", "🍭", "🍬", "🍫",
      "🍿", "🍩", "🍪", "🌰", "🥜", "🍯", "🥛", "☕️", "🫖", "🍵",
      "🧃", "🥤", "🧋", "🍶", "🍺", "🍻", "🥂", "🍷", "🥃", "🍸",
      "🍹", "🍾", "🧊",
    ],
  },
  {
    id: "activities",
    name: "Activities",
    icon: "⚽️",
    emojis: [
      "⚽️", "🏀", "🏈", "⚾️", "🥎", "🎾", "🏐", "🏉", "🥏", "🎱",
      "🪀", "🏓", "🏸", "🏒", "👡", "🏹", "🎣", "🤿", "🥊", "🥋",
      "🎽", "🛹", "🛼", "🛷", "⛸", "🥌", "🎿", "⛷", "🏂", "🪂",
      "🏋️", "🤼", "🤸", "⛹️", "🤺", "🤾", "🏌️", "🏇", "🧘", "🏄",
      "🏊", "🤽", "🚣", "🧗", "🚵", "🚴", "🏆", "🥇", "🥈", "🥉",
      "🏅", "🎖", "🏵", "🎗", "🎫", "🎟", "🎪", "🤹", "🎭", "🩰",
      "🎨", "🎬", "🎤", "🎧", "🎼", "🎹", "🥁", "🎷", "🎺", "🎸",
      "🪕", "🎻", "🎲", "♟", "🎯", "🎳", "🎮", "🎰", "🧩",
    ],
  },
  {
    id: "objects",
    name: "Objects & Symbols",
    icon: "💎",
    emojis: [
      "❤️", "🧡", "💛", "💚", "💙", "💜", "🖤", "🤍", "🤎", "💔",
      "❣️", "💕", "💞", "💓", "💗", "💖", "💘", "💝", "💟", "💎",
      "🔑", "🗝️", "📱", "📲", "💻", "⌨️", "🖥️", "🖨️", "🖱️", "🎮",
      "🎥", "📷", "📸", "📹", "📺", "📻", "🎙️", "🔔", "🔕", "📢",
      "📣", "🔍", "🔎", "💡", "🔦", "🕯️", "📖", "📚", "📓", "📝",
      "✏️", "✒️", "🖋️", "📌", "📍", "📎", "📁", "📂", "📅", "📆",
      "🔒", "🔓", "🔏", "🔐", "💯", "💢", "💥", "💫", "💦", "💨",
      "🎉", "🎊", "🎈", "🎁", "🎗️", "🏆", "🎯", "🎲", "♟️", "🧩",
    ],
  },
];

const EMOJI_KEYWORDS: Record<string, string> = {
  "😀": "grinning smile happy face",
  "😃": "smile happy joy face",
  "😄": "smile happy laugh face",
  "😁": "grin happy smile",
  "😆": "laugh haha lol xd",
  "😅": "sweat smile phew",
  "😂": "joy tears laugh lol rofl",
  "🤣": "rofl laugh tears lol",
  "😊": "blush happy smile",
  "😇": "halo angel innocent",
  "🙂": "slight smile happy",
  "🙃": "upside down silly",
  "😉": "wink playful",
  "😍": "love heart eyes",
  "🥰": "hearts love cute",
  "😘": "kiss love",
  "😋": "yum delicious food",
  "😜": "tongue wink playful",
  "🤪": "crazy zany goofy",
  "😎": "cool sunglasses glasses",
  "🥳": "party celebrate hat",
  "😏": "smirk coy",
  "😒": "unamused meh",
  "😔": "pensive sad",
  "😟": "worried concerned",
  "😢": "cry tear sad",
  "😭": "sob cry tears sad",
  "😱": "scream fear shocked",
  "😳": "flustered blush shocked",
  "😡": "rage angry mad red",
  "🤬": "cursing swearing angry",
  "🤯": "mind blown exploding head",
  "💀": "skull dead dead",
  "💩": "poop poopie",
  "🤡": "clown silly",
  "👻": "ghost boo spooky",
  "👽": "alien space ufo",
  "🤖": "robot bot",
  "👋": "wave hello hi goodbye",
  "✋": "hand stop hi5",
  "👌": "ok okay perfect",
  "✌️": "peace victory",
  "🤞": "fingers crossed luck",
  "🤟": "love-you rock",
  "🤘": "rock-on metal",
  "👍": "thumbsup like yes agree +1",
  "👎": "thumbsdown dislike no -1",
  "👏": "clap applause bravo",
  "🙌": "raised hands praise celebration",
  "🙏": "pray please thank-you thanks",
  "💪": "flex muscle strong flex",
  "❤️": "heart love red-heart",
  "🔥": "fire flame hot lit",
  "✨": "sparkles shiny magic",
  "⭐": "star yellow-star",
  "🎉": "tada party celebration",
  "🚀": "rocket launch ship",
  "🐶": "dog puppy animal",
  "🐱": "cat kitten meow",
  "🍕": "pizza food cheese",
  "🍔": "burger hamburger food",
  "☕️": "coffee tea drink mug",
  "🍺": "beer drink alcohol cheers",
  "🍷": "wine drink glass",
};

const ANIMATED_TAB_ID = "animated";

/** A single grid cell: either a plain Unicode glyph or a bundled animated
 * emoji. Search results mix both; category browsing shows one or the
 * other depending on the active tab. */
type EmojiHit = { kind: "glyph"; glyph: string } | { kind: "animated"; id: string; name: string };

type EmojiPickerProps = {
  onSelectEmoji: (emoji: string) => void;
  onClose: () => void;
  /** Positioning classes for the popover root; defaults to the composer's
   * bottom-right anchor. */
  className?: string;
};

export function EmojiPicker({
  onSelectEmoji,
  onClose,
  className = "absolute bottom-16 right-0 z-50",
}: EmojiPickerProps) {
  const [activeCategory, setActiveCategory] = useState<string>("smileys");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  const q = searchQuery.toLowerCase().trim();
  const hits: EmojiHit[] = q
    ? [
        ...EMOJI_CATEGORIES.flatMap((cat) => cat.emojis)
          .filter((emoji) => {
            const keywords = EMOJI_KEYWORDS[emoji] ?? "";
            return emoji.includes(q) || keywords.toLowerCase().includes(q);
          })
          .map((glyph): EmojiHit => ({ kind: "glyph", glyph })),
        ...ANIMATED_EMOJI.filter((e) => e.keywords.toLowerCase().includes(q) || e.name.toLowerCase().includes(q)).map(
          (e): EmojiHit => ({ kind: "animated", id: e.id, name: e.name }),
        ),
      ]
    : activeCategory === ANIMATED_TAB_ID
      ? ANIMATED_EMOJI.map((e): EmojiHit => ({ kind: "animated", id: e.id, name: e.name }))
      : (EMOJI_CATEGORIES.find((cat) => cat.id === activeCategory)?.emojis ?? []).map(
          (glyph): EmojiHit => ({ kind: "glyph", glyph }),
        );

  return (
    <motion.div
      ref={popoverRef}
      initial={{ opacity: 0, scale: 0.95, y: 10 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.95, y: 10 }}
      transition={{ duration: 0.15, ease: "easeOut" }}
      className={`${className} flex h-96 w-80 flex-col overflow-hidden rounded-2xl border border-border bg-bg-elevated/95 shadow-modal backdrop-blur-xl`}
    >
      {/* Header & Search */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border/60 bg-bg-secondary/40 px-3 py-2.5">
        <Search size={15} className="shrink-0 text-text-muted" />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search emojis…"
          className="w-full border-0 bg-transparent text-xs text-text-primary outline-none focus:outline-none focus:ring-0 focus:border-0 shadow-none placeholder:text-text-muted select-text"
          autoFocus
        />
        {searchQuery && (
          <button
            type="button"
            onClick={() => setSearchQuery("")}
            className="rounded p-0.5 text-text-muted hover:text-text-primary"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {/* Category Tabs */}
      {!searchQuery && (
        <div className="flex shrink-0 items-center justify-around border-b border-border/40 bg-bg-secondary/20 px-1 py-1 text-base">
          {EMOJI_CATEGORIES.map((cat) => (
            <button
              key={cat.id}
              type="button"
              onClick={() => setActiveCategory(cat.id)}
              title={cat.name}
              className={`flex h-8 w-8 items-center justify-center rounded-lg transition-colors ${
                activeCategory === cat.id ? "bg-accent/20 text-accent" : "hover:bg-bg-tertiary"
              }`}
            >
              <span>{cat.icon}</span>
            </button>
          ))}
          <button
            type="button"
            onClick={() => setActiveCategory(ANIMATED_TAB_ID)}
            title="Animated"
            className={`flex h-8 w-8 items-center justify-center rounded-lg transition-colors ${
              activeCategory === ANIMATED_TAB_ID ? "bg-accent/20 text-accent" : "hover:bg-bg-tertiary"
            }`}
          >
            <span>✨</span>
          </button>
        </div>
      )}

      {/* Emoji Grid */}
      <div className="flex-1 overflow-y-auto p-3 scrollbar-thin scrollbar-thumb-border">
        {!searchQuery && (
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
            {activeCategory === ANIMATED_TAB_ID
              ? "Animated"
              : EMOJI_CATEGORIES.find((c) => c.id === activeCategory)?.name}
          </p>
        )}
        <div className="grid grid-cols-8 gap-1.5 text-xl">
          {hits.map((hit, idx) =>
            hit.kind === "glyph" ? (
              <button
                key={`glyph-${hit.glyph}-${idx}`}
                type="button"
                onClick={() => onSelectEmoji(hit.glyph)}
                className="flex h-8 w-8 items-center justify-center rounded-lg hover:scale-125 hover:bg-bg-tertiary transition-transform duration-100"
              >
                <span>{hit.glyph}</span>
              </button>
            ) : (
              <button
                key={`animated-${hit.id}`}
                type="button"
                title={hit.name}
                onClick={() => onSelectEmoji(animatedEmojiToken(hit.id))}
                className="flex h-8 w-8 items-center justify-center rounded-lg hover:scale-125 hover:bg-bg-tertiary transition-transform duration-100"
              >
                <img src={resolveAnimatedEmojiUrl(hit.id) ?? ""} alt={hit.name} className="h-7 w-7" loading="lazy" />
              </button>
            ),
          )}
        </div>
      </div>
    </motion.div>
  );
}
