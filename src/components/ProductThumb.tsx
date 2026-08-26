import { Luggage } from "lucide-react";
import { cn } from "@/lib/utils";

const PALETTE = ["#5B6B4A", "#10B981", "#8B7D5B", "#A0522D", "#6B8E6B", "#7C6E4F", "#4A6B5B"];

function pick(seed: string) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 997;
  return PALETTE[h % PALETTE.length];
}

export function ProductThumb({
  id,
  name,
  className,
  size = 40,
}: {
  id: string;
  name: string;
  className?: string;
  size?: number;
}) {
  const color = pick(id);
  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-muted",
        className,
      )}
      style={{ width: className ? undefined : size, height: className ? undefined : size }}
      role="img"
      aria-label={name}
    >
      <Luggage style={{ color }} className="h-1/2 w-1/2" strokeWidth={1.6} />
    </div>
  );
}
