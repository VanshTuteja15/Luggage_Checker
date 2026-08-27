"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, Loader2, MessageCircle, Send, X, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
};

const WELCOME: Message = {
  id: "welcome",
  role: "assistant",
  content:
    "Hey! I'm your LuggageTracker AI assistant. Ask me anything about luggage prices, deals, or products across Canadian retailers. Try:\n\n• \"What's the cheapest Samsonite right now?\"\n• \"Any price drops today?\"\n• \"Compare TUMI vs Away\"",
  timestamp: new Date(),
};

const SUGGESTIONS = [
  "Best deals right now?",
  "Any price drops today?",
  "Cheapest luggage under $200",
  "What can you do?",
];

/**
 * Render markdown-light text:
 * **bold**, bullet points, and newlines.
 */
function renderContent(text: string) {
  return text.split("\n").map((line, i) => {
    // Process bold **text**
    const parts = line.split(/(\*\*[^*]+\*\*)/g).map((part, j) => {
      if (part.startsWith("**") && part.endsWith("**")) {
        return (
          <strong key={j} className="font-semibold">
            {part.slice(2, -2)}
          </strong>
        );
      }
      // Process italic _text_
      return part.split(/(_[^_]+_)/g).map((sub, k) => {
        if (sub.startsWith("_") && sub.endsWith("_")) {
          return (
            <em key={`${j}-${k}`} className="text-muted-foreground">
              {sub.slice(1, -1)}
            </em>
          );
        }
        return sub;
      });
    });

    if (line.trim().startsWith("- ") || line.trim().startsWith("• ")) {
      return (
        <li key={i} className="ml-4 list-disc">
          {parts}
        </li>
      );
    }
    if (/^\d+\.\s/.test(line.trim())) {
      return (
        <li key={i} className="ml-4 list-decimal">
          {parts}
        </li>
      );
    }
    if (line.trim() === "") return <br key={i} />;
    return <p key={i}>{parts}</p>;
  });
}

export function AiChat() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([WELCOME]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, loading]);

  // Focus input when opened
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || loading) return;

      const userMsg: Message = {
        id: `u-${Date.now()}`,
        role: "user",
        content: trimmed,
        timestamp: new Date(),
      };

      setMessages((prev) => [...prev, userMsg]);
      setInput("");
      setLoading(true);

      try {
        // Send full conversation history (without welcome) for context
        const history = [...messages.filter((m) => m.id !== "welcome"), userMsg].map(
          (m) => ({ role: m.role, content: m.content }),
        );

        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: history }),
        });

        const data = await res.json();
        const reply = data.reply ?? data.error ?? "Sorry, something went wrong.";

        const assistantMsg: Message = {
          id: `a-${Date.now()}`,
          role: "assistant",
          content: reply,
          timestamp: new Date(),
        };

        setMessages((prev) => [...prev, assistantMsg]);
      } catch {
        setMessages((prev) => [
          ...prev,
          {
            id: `e-${Date.now()}`,
            role: "assistant",
            content: "Oops — couldn't reach the AI service. Try again in a moment.",
            timestamp: new Date(),
          },
        ]);
      } finally {
        setLoading(false);
      }
    },
    [messages, loading],
  );

  return (
    <>
      {/* Floating action button */}
      <button
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "fixed bottom-6 right-6 z-50 flex h-14 w-14 items-center justify-center rounded-full shadow-lg transition-all duration-200 hover:scale-105",
          open
            ? "bg-muted text-muted-foreground"
            : "bg-[#5B6B4A] text-white hover:bg-[#4a5a3d]",
        )}
        aria-label={open ? "Close AI chat" : "Open AI chat"}
      >
        {open ? <X className="h-5 w-5" /> : <MessageCircle className="h-5 w-5" />}
      </button>

      {/* Chat panel */}
      {open && (
        <div className="fixed bottom-24 right-6 z-50 flex h-[520px] w-[380px] flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl sm:w-[420px]">
          {/* Header */}
          <div className="flex items-center gap-3 border-b border-border bg-[#5B6B4A] px-4 py-3 text-white">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-white/15">
              <Sparkles className="h-4.5 w-4.5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">LuggageTracker AI</p>
              <p className="text-xs text-white/70">Powered by Google Gemini</p>
            </div>
            <div className="flex h-2 w-2 rounded-full bg-emerald-400" title="Online" />
          </div>

          {/* Messages */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={cn(
                  "flex",
                  msg.role === "user" ? "justify-end" : "justify-start",
                )}
              >
                <div
                  className={cn(
                    "max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed",
                    msg.role === "user"
                      ? "rounded-br-md bg-[#5B6B4A] text-white"
                      : "rounded-bl-md bg-muted text-foreground",
                  )}
                >
                  {msg.role === "assistant" && (
                    <div className="mb-1 flex items-center gap-1.5">
                      <Bot className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="text-[11px] font-medium text-muted-foreground">AI</span>
                    </div>
                  )}
                  <div className="space-y-1">{renderContent(msg.content)}</div>
                </div>
              </div>
            ))}

            {/* Typing indicator */}
            {loading && (
              <div className="flex justify-start">
                <div className="flex items-center gap-2 rounded-2xl rounded-bl-md bg-muted px-4 py-3">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  <span className="text-xs text-muted-foreground">Thinking…</span>
                </div>
              </div>
            )}
          </div>

          {/* Suggestion chips (only when few messages) */}
          {messages.length <= 2 && !loading && (
            <div className="flex flex-wrap gap-1.5 border-t border-border px-4 py-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => sendMessage(s)}
                  className="rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  {s}
                </button>
              ))}
            </div>
          )}

          {/* Input */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              sendMessage(input);
            }}
            className="flex items-center gap-2 border-t border-border px-3 py-2.5"
          >
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask about prices, deals, products…"
              disabled={loading}
              className="flex-1 bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={!input.trim() || loading}
              className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#5B6B4A] text-white transition-colors hover:bg-[#4a5a3d] disabled:opacity-40"
            >
              <Send className="h-3.5 w-3.5" />
            </button>
          </form>
        </div>
      )}
    </>
  );
}
