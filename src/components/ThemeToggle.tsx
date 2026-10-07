"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTheme, type Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";

const OPTIONS: { value: Theme; label: string; hint: string; icon: typeof Sun }[] = [
  { value: "light", label: "Light", hint: "Always bright", icon: Sun },
  { value: "dark", label: "Dark", hint: "Always dim", icon: Moon },
  { value: "system", label: "System", hint: "Match the device", icon: Monitor },
];

export function ThemeToggle({ className }: { className?: string }) {
  const { theme, resolved, setTheme } = useTheme();
  const Icon = resolved === "dark" ? Moon : Sun;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="icon" className={className} aria-label="Change theme">
          <Icon className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-36">
        <DropdownMenuRadioGroup value={theme} onValueChange={(v) => setTheme(v as Theme)}>
          {OPTIONS.map((opt) => (
            <DropdownMenuRadioItem key={opt.value} value={opt.value}>
              <opt.icon className="mr-2 h-4 w-4" />
              {opt.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ThemePicker() {
  const { theme, setTheme } = useTheme();

  return (
    <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Theme">
      {OPTIONS.map((opt) => {
        const selected = theme === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => setTheme(opt.value)}
            className={cn(
              "flex items-start gap-3 rounded-lg border px-4 py-3 text-left transition-colors",
              selected
                ? "border-primary bg-primary-soft text-foreground"
                : "border-border bg-background text-muted-foreground hover:bg-accent hover:text-accent-foreground",
            )}
          >
            <opt.icon className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              <span className="block text-sm font-medium">{opt.label}</span>
              <span className="block text-xs opacity-70">{opt.hint}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
