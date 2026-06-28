import { describe, expect, test } from "bun:test";
import { CompositeComponent, createCompositeComponent, renderServerComponent } from "furin/rsc";
import type { ComponentType, ReactNode } from "react";
import { renderToReadableStream } from "react-dom/server";

describe("RSC public API", () => {
  test("renderServerComponent returns a React-renderable value", async () => {
    const article = await renderServerComponent(<h1>Composite RSC</h1>);

    const stream = await renderToReadableStream(<main>{article}</main>);
    const html = await new Response(stream).text();

    expect(html).toBe("<main><h1>Composite RSC</h1></main>");
  });

  test("a composite invokes children and render-prop slots", async () => {
    const Card = await createCompositeComponent<{
      children: ReactNode;
      footer: (label: string) => ReactNode;
    }>(({ children, footer }) => (
      <article>
        {children}
        <footer>{footer("Loaded")}</footer>
      </article>
    ));

    const stream = await renderToReadableStream(
      <CompositeComponent footer={(label) => <button type="button">{label}</button>} src={Card}>
        <h2>Profile</h2>
      </CompositeComponent>
    );
    const html = await new Response(stream).text();

    expect(html).toBe(
      '<article><h2>Profile</h2><footer><button type="button">Loaded</button></footer></article>'
    );
  });

  test("a composite invokes a typed component slot", async () => {
    const Toolbar = await createCompositeComponent<{
      Action: ComponentType<{ label: string }>;
    }>(({ Action }) => (
      <nav>
        <Action label="Save" />
      </nav>
    ));

    const stream = await renderToReadableStream(
      <CompositeComponent
        Action={({ label }) => <button type="button">{label}</button>}
        src={Toolbar}
      />
    );
    const html = await new Response(stream).text();

    expect(html).toBe('<nav><button type="button">Save</button></nav>');
  });
});
