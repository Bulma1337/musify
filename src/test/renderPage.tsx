import type { ReactElement } from "react";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router";
import "@/i18n";
import { useSession } from "@/api/session";
import { ScrollContainerContext } from "@/app/layout/scrollContainer";
import { usePlayer } from "@/player/store";
import { createFakeProvider } from "./fakeProvider";

/**
 * Renders a page inside the same providers the app uses, with the in-memory fake server.
 *
 * @param path   route pattern, e.g. "/album/:id"
 * @param url    initial URL, e.g. "/album/al1"
 */
export function renderPage(
  element: ReactElement,
  { path = "/", url = "/" }: { path?: string; url?: string } = {},
) {
  const provider = createFakeProvider();
  useSession.setState({
    provider,
    status: "ready",
    servers: [provider.server],
    activeServerId: provider.server.id,
  });
  usePlayer.setState({
    context: null,
    contextItems: [],
    order: [],
    orderIndex: 0,
    manualQueue: [],
    current: null,
  });

  const scroll = document.createElement("div");
  document.body.appendChild(scroll);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [
      {
        path,
        element: <ScrollContainerContext.Provider value={scroll}>{element}</ScrollContainerContext.Provider>,
      },
    ],
    { initialEntries: [url] },
  );
  const result = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...result, provider, router, queryClient };
}
