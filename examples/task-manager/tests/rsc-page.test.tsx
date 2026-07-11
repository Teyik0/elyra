import { afterAll, expect, mock, test } from "bun:test";
import { renderToReadableStream } from "react-dom/server";

mock.module("../src/api/modules/boards/service", () => ({
  getBoards: () => [
    {
      createdAt: "2026-05-01T00:00:00.000Z",
      id: "board-rsc",
      name: "RSC board",
    },
  ],
}));

afterAll(() => {
  const restorer = mock as typeof mock & { restoreModule?: (id?: string) => void };
  restorer.restoreModule?.("../src/api/modules/boards/service");
  mock.restore();
});

test("the RSC page renders server-owned boards with client interaction slots", async () => {
  const page = (await import("../src/pages/rsc")).default;
  const loaderData = await page.loader?.({});

  expect(loaderData).toBeDefined();

  const Component = page.component;
  const stream = await renderToReadableStream(
    <Component {...loaderData} params={{}} path="/rsc" query={{}} />
  );
  const html = await new Response(stream).text();

  expect(html).toContain("RSC board");
  expect(html).toContain('aria-label="New board name"');
  expect(html).toContain('aria-label="Delete board-rsc"');
});
