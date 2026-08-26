"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { StoreProvider } from "@/lib/store";
import { Toaster } from "@/components/ui/sonner";

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <QueryClientProvider client={queryClient}>
      <StoreProvider>
        {children}
        <Toaster position="bottom-right" richColors />
      </StoreProvider>
    </QueryClientProvider>
  );
}
