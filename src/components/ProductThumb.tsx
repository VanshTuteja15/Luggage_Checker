import { Luggage } from "lucide-react";
import { cn } from "@/lib/utils";

const PALETTE = ["#5B6B4A", "#10B981", "#8B7D5B", "#A0522D", "#6B8E6B", "#7C6E4F", "#4A6B5B"];

function pick(seed: string) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 997;
  return PALETTE[h % PALETTE.length];
}

/**
 * Product thumbnail. Uses the real retailer image when we have one and falls
 * back to a deterministic coloured icon so the layout never jumps.
 */
export function ProductThumb({
  id,
  name,
  imageUrl,
  className,
  size = 40,
}: {
  id: string;
  name: string;
  imageUrl?: string | null;
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
      {imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={imageUrl}
          alt={name}
          className="h-full w-full object-contain"
          loading="lazy"
        />
      ) : (
        <Luggage style={{ color }} className="h-1/2 w-1/2" strokeWidth={1.6} />
      )}
    </div>
  );
}
