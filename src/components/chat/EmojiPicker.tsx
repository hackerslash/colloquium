import { useEffect, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { motion } from "motion/react";

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

type EmojiPickerProps = {
  onSelectEmoji: (emoji: string) => void;
  onClose: () => void;
};

export function EmojiPicker({ onSelectEmoji, onClose }: EmojiPickerProps) {
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

  const filteredEmojis = searchQuery.trim()
    ? EMOJI_CATEGORIES.flatMap((cat) => cat.emojis).filter((_) => true) // All emojis during search
    : EMOJI_CATEGORIES.find((cat) => cat.id === activeCategory)?.emojis ?? [];

  return (
    <motion.div
      ref={popoverRef}
      initial={{ opacity: 0, scale: 0.95, y: 10 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.95, y: 10 }}
      transition={{ duration: 0.15, ease: "easeOut" }}
      className="absolute bottom-16 right-0 z-50 flex h-96 w-80 flex-col overflow-hidden rounded-2xl border border-border bg-bg-elevated/95 shadow-modal backdrop-blur-xl"
    >
      {/* Header & Search */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border/60 bg-bg-secondary/40 px-3 py-2.5">
        <Search size={15} className="shrink-0 text-text-muted" />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search emojis…"
          className="w-full bg-transparent text-xs text-text-primary outline-none placeholder:text-text-muted"
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
        </div>
      )}

      {/* Emoji Grid */}
      <div className="flex-1 overflow-y-auto p-3 scrollbar-thin scrollbar-thumb-border">
        {!searchQuery && (
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
            {EMOJI_CATEGORIES.find((c) => c.id === activeCategory)?.name}
          </p>
        )}
        <div className="grid grid-cols-8 gap-1.5 text-xl">
          {filteredEmojis.map((emoji, idx) => (
            <button
              key={`${emoji}-${idx}`}
              type="button"
              onClick={() => {
                onSelectEmoji(emoji);
              }}
              className="flex h-8 w-8 items-center justify-center rounded-lg hover:scale-125 hover:bg-bg-tertiary transition-transform duration-100"
            >
              <span>{emoji}</span>
            </button>
          ))}
        </div>
      </div>
    </motion.div>
  );
}
