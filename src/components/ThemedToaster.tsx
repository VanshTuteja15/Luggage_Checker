"use client";

import { Toaster } from "@/components/ui/sonner";
import { useTheme } from "@/lib/theme";

export function ThemedToaster() {
  const { resolved } = useTheme();
  return <Toaster position="bottom-right" richColors theme={resolved} />;
}
