"use client";

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Clock, Loader2, Search as SearchIcon, TrendingUp, X } from "lucide-react";
import { Button } from "@/components/ui/button";

/* ------------------------------------------------------------------ */
/*  Search box with a Google-style history dropdown                   */
/*                                                                     */
/*  Focus (or click) the box and your recent searches drop down;       */
/*  typing filters them. ↑/↓ to move, Enter to search, Esc to close,   */
/*  × to forget one search. Searching again from history is free for  */
/*  6 hours — the answer comes from cache.                             */
/* ------------------------------------------------------------------ */

type Props = {
  value: string;
  onChange: (value: string) => void;
  onSearch: (term: string) => void;
  history: string[];
  onRemoveHistory: (term: string) => void;
  onClearHistory: () => void;
  /** Shown when there's no history yet. */
  suggestions?: string[];
  pending?: boolean;
  placeholder?: string;
};

type Row = { term: string; kind: "history" | "suggestion" };

export function SearchBox({
  value,
  onChange,
  onSearch,
  history,
  onRemoveHistory,
  onClearHistory,
  suggestions = [],
  pending = false,
  placeholder,
}: Props) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const rows = useMemo<Row[]>(() => {
    const q = value.trim().toLowerCase();
    const matches = history.filter((h) => !q || (h.toLowerCase().includes(q) && h.toLowerCase() !== q));
    const list: Row[] = matches.slice(0, 8).map((term) => ({ term, kind: "history" }));
    if (!q && list.length === 0) {
      for (const term of suggestions.slice(0, 6)) list.push({ term, kind: "suggestion" });
    }
    return list;
  }, [value, history, suggestions]);

  // Reset the highlight whenever the list changes.
  useEffect(() => setActive(-1), [rows.length, value]);

  // Close when clicking anywhere outside.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const submit = (term: string) => {
    const t = term.trim();
    if (!t) return;
    onChange(t);
    setOpen(false);
    inputRef.current?.blur();
    onSearch(t);
  };

  const showList = open && rows.length > 0;

  return (
    <div ref={wrapRef} className="relative">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit(active >= 0 && rows[active] ? rows[active].term : value);
        }}
        className="relative"
        role="search"
      >
        <SearchIcon className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" />
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setOpen(true);
              setActive((i) => (rows.length ? (i + 1) % rows.length : -1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((i) => (rows.length ? (i <= 0 ? rows.length - 1 : i - 1) : -1));
            } else if (e.key === "Escape") {
              setOpen(false);
              setActive(-1);
            }
          }}
          placeholder={placeholder}
          maxLength={200}
          autoComplete="off"
          spellCheck={false}
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
          className={`h-14 w-full border border-input bg-background pl-12 pr-32 text-base shadow-sm outline-none transition-[border-radius] placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/40 ${
            showList ? "rounded-t-2xl rounded-b-none border-b-transparent" : "rounded-2xl"
          }`}
        />
        {value && !pending && (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => {
              onChange("");
              inputRef.current?.focus();
              setOpen(true);
            }}
            className="absolute right-[7.25rem] top-1/2 -translate-y-1/2 rounded-full p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        )}
        <Button
          type="submit"
          disabled={!value.trim()}
          className="absolute right-2 top-1/2 h-10 -translate-y-1/2 gap-2 rounded-xl px-5"
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <SearchIcon className="h-4 w-4" />}
          Search
        </Button>
      </form>

      {showList && (
        <div className="absolute inset-x-0 top-full z-30 overflow-hidden rounded-b-2xl border border-t-0 border-input bg-popover shadow-lg">
          <div className="mx-4 border-t border-border" />
          <ul id={listId} role="listbox" className="py-1.5">
            {rows.map((row, i) => (
              <li
                key={`${row.kind}:${row.term}`}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                onMouseEnter={() => setActive(i)}
                // mousedown, not click: fires before the input loses focus.
                onMouseDown={(e) => {
                  e.preventDefault();
                  submit(row.term);
                }}
                className={`group flex cursor-pointer items-center gap-3 px-4 py-2 text-sm ${
                  i === active ? "bg-muted" : ""
                }`}
              >
                {row.kind === "history" ? (
                  <Clock className="h-4 w-4 shrink-0 text-muted-foreground" />
                ) : (
                  <TrendingUp className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1 truncate">{highlight(row.term, value)}</span>
                {row.kind === "history" && (
                  <button
                    type="button"
                    aria-label={`Remove “${row.term}” from history`}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      onRemoveHistory(row.term);
                    }}
                    className="rounded-full p-1 text-muted-foreground opacity-60 hover:bg-background hover:text-foreground group-hover:opacity-100"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </li>
            ))}
          </ul>
          {rows.some((r) => r.kind === "history") && (
            <div className="flex items-center justify-between border-t border-border px-4 py-2 text-xs text-muted-foreground">
              <span>{rows[0].kind === "history" ? "Recent searches · repeats within 6h are free" : "Try a search"}</span>
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  onClearHistory();
                }}
                className="font-medium hover:text-foreground"
              >
                Clear history
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Typed text in normal weight, the rest of the suggestion bold — like Google. */
function highlight(term: string, typed: string): ReactNode {
  const q = typed.trim();
  if (!q) return term;
  const i = term.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return term;
  return (
    <>
      <span className="font-semibold">{term.slice(0, i)}</span>
      {term.slice(i, i + q.length)}
      <span className="font-semibold">{term.slice(i + q.length)}</span>
    </>
  );
}
