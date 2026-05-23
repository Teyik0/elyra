import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      // Docs content is static for the lifetime of a session: the search
      // index never changes and a query's results are deterministic, so
      // nothing ever needs to be refetched once resolved.
      queries: {
        gcTime: Number.POSITIVE_INFINITY,
        retry: 2,
        staleTime: Number.POSITIVE_INFINITY,
      },
    },
  });
}

export function DocsQueryProvider({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(createQueryClient);

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
