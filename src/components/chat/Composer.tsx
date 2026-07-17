import { useEffect, useRef, useState } from "react";
import { Paperclip, SendHorizontal, X } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { IconButton } from "../ui/IconButton";
import { MAX_FILE_SIZE } from "../../services/room/chatService";
import { toast } from "../../stores/useToastStore";

type ComposerProps = {
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
  onSend: (file?: File) => void;
};

export function Composer({ value, placeholder, onChange, onSend }: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  function autoGrow() {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }

  useEffect(() => {
    autoGrow();
  }, [value]);

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    onChange(e.target.value);
    autoGrow();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleSend() {
    if (!value.trim() && !selectedFile) return;
    onSend(selectedFile ?? undefined);
    setSelectedFile(null);
  }

  return (
    <div className="px-4 pb-6 pt-2">
      <AnimatePresence>
        {selectedFile && (
          <motion.div
            initial={{ opacity: 0, y: 10, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.95 }}
            className="mb-3 flex items-center gap-2 rounded-xl bg-bg-elevated/80 px-4 py-2.5 text-sm text-text-primary shadow-lg backdrop-blur-md border border-white/10 mx-auto max-w-2xl"
          >
            <Paperclip size={16} className="text-text-muted" />
            <span className="flex-1 truncate font-medium">{selectedFile.name}</span>
            <button
              onClick={() => setSelectedFile(null)}
              className="rounded-full bg-white/5 p-1 text-text-muted transition-colors hover:bg-danger/20 hover:text-danger"
            >
              <X size={14} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
      <div className="mx-auto flex max-w-2xl items-end gap-2 rounded-[24px] border border-white/10 bg-bg-tertiary/60 px-3 py-2 shadow-xl backdrop-blur-2xl transition-all focus-within:border-accent/50 focus-within:bg-bg-tertiary/80 focus-within:shadow-accent/10 focus-within:shadow-2xl">
        <input
          type="file"
          ref={fileInputRef}
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) {
              if (file.size > MAX_FILE_SIZE) {
                toast.error(
                  "File too large",
                  `Attachments are limited to ${Math.round(MAX_FILE_SIZE / (1024 * 1024))} MB.`,
                );
              } else {
                setSelectedFile(file);
              }
            }
            if (fileInputRef.current) fileInputRef.current.value = "";
          }}
        />
        <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }} className="mb-0.5 ml-1">
          <IconButton
            icon={Paperclip}
            label="Attach file"
            size="sm"
            variant="ghost"
            tooltip={false}
            onClick={() => fileInputRef.current?.click()}
          />
        </motion.div>
        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          rows={1}
          placeholder={placeholder}
          aria-label="Message"
          className="max-h-40 flex-1 resize-none border-none bg-transparent px-2 py-2.5 text-sm text-text-primary outline-none placeholder:text-text-muted"
        />
        <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }} className="mb-0.5 mr-1">
          <IconButton
            icon={SendHorizontal}
            label="Send"
            size="sm"
            variant={value.trim() || selectedFile ? "accent" : "ghost"}
            disabled={!value.trim() && !selectedFile}
            tooltip={false}
            onClick={handleSend}
          />
        </motion.div>
      </div>
    </div>
  );
}
