"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { StoreProvider } from "@/lib/store";
import { ThemeProvider } from "@/lib/theme";
import { ThemedToaster } from "@/components/ThemedToaster";

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <StoreProvider>
          {children}
          <ThemedToaster />
        </StoreProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
