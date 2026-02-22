import { describe, expect, test } from "bun:test";
import {
  createClientReference,
  transformClientComponent,
  transformServerComponent,
} from "../../src/rsc/transform";
import type { ClientReference, ModuleAnalysis } from "../../src/rsc/types";

describe("transformServerComponent", () => {
  test("removes client imports and replaces with references", () => {
    const code = `
      import { Counter } from './Counter.client';
      import { Button } from './Button.client';
      
      export default function Page() {
        return (
          <div>
            <Counter />
            <Button />
          </div>
        );
      }
    `;

    const analysis: ModuleAnalysis = {
      path: "/pages/index.tsx",
      type: "server",
      exports: [{ name: "default", type: "server" }],
      clientFeatures: [],
    };

    const clientReferences = new Map<string, ClientReference>();
    clientReferences.set("./Counter.client", {
      $$typeof: Symbol.for("react.client.reference"),
      $$id: "Counter.tsx",
      $$name: "Counter",
      $$bundles: ["Counter.js"],
    });
    clientReferences.set("./Button.client", {
      $$typeof: Symbol.for("react.client.reference"),
      $$id: "Button.client.tsx",
      $$name: "Button",
      $$bundles: ["Button.client.js"],
    });

    const result = transformServerComponent(code, analysis, clientReferences);

    expect(result).not.toContain("import { Counter }");
    expect(result).toContain("createClientReference");
  });

  test("preserves server imports", () => {
    const code = `
      import { db } from './db';
      import { formatDate } from './utils';
      
      export default async function Page() {
        const user = await db.users.findFirst();
        return <div>{formatDate(user.createdAt)}</div>;
      }
    `;

    const analysis: ModuleAnalysis = {
      path: "/pages/index.tsx",
      type: "server",
      exports: [{ name: "default", type: "server" }],
      clientFeatures: [],
    };

    const result = transformServerComponent(code, analysis, new Map());

    expect(result).toContain("import { db }");
    expect(result).toContain("import { formatDate }");
  });

  test("handles components with no client imports", () => {
    const code = `
      export default function Page() {
        return <div>Hello World</div>;
      }
    `;

    const analysis: ModuleAnalysis = {
      path: "/pages/index.tsx",
      type: "server",
      exports: [{ name: "default", type: "server" }],
      clientFeatures: [],
    };

    const result = transformServerComponent(code, analysis, new Map());

    expect(result).toContain("Hello World");
  });
});

describe("transformClientComponent", () => {
  test("strips loader from client component", () => {
    const code = `
      export default function Page() {
        const [count, setCount] = useState(0);
        return <button onClick={() => setCount(c => c + 1)}>{count}</button>;
      }
      
      Page.loader = async () => {
        return { data: await fetchData() };
      };
    `;

    const analysis: ModuleAnalysis = {
      path: "/pages/counter.tsx",
      type: "client",
      exports: [{ name: "default", type: "client" }],
      clientFeatures: ["useState", "onClick"],
    };

    const result = transformClientComponent(code, analysis);

    expect(result).not.toContain("Page.loader");
    expect(result).toContain("useState");
  });

  test("preserves all hooks and event handlers", () => {
    const code = `
      export function Form() {
        const [value, setValue] = useState('');
        const ref = useRef(null);
        
        const handleSubmit = (e) => {
          e.preventDefault();
        };
        
        return (
          <form onSubmit={handleSubmit}>
            <input value={value} onChange={(e) => setValue(e.target.value)} ref={ref} />
          </form>
        );
      }
    `;

    const analysis: ModuleAnalysis = {
      path: "/components/Form.tsx",
      type: "client",
      exports: [{ name: "Form", type: "client" }],
      clientFeatures: ["useState", "useRef", "onSubmit", "onChange"],
    };

    const result = transformClientComponent(code, analysis);

    expect(result).toContain("useState");
    expect(result).toContain("useRef");
    expect(result).toContain("onSubmit");
    expect(result).toContain("onChange");
  });

  test("strips loader assignment without async", () => {
    const code = `
      export function Component() {
        return <div>Test</div>;
      }
      
      Component.loader = someLoader;
    `;

    const analysis: ModuleAnalysis = {
      path: "/components/Component.tsx",
      type: "client",
      exports: [{ name: "Component", type: "client" }],
      clientFeatures: [],
    };

    const result = transformClientComponent(code, analysis);

    expect(result).not.toContain("Component.loader");
    expect(result).toContain("Test");
  });

  test("strips loader assignment with function call", () => {
    const code = `
      export function Page() {
        return <div>Page</div>;
      }
      
      Page.loader = createLoader();
    `;

    const analysis: ModuleAnalysis = {
      path: "/pages/Page.tsx",
      type: "client",
      exports: [{ name: "Page", type: "client" }],
      clientFeatures: [],
    };

    const result = transformClientComponent(code, analysis);

    expect(result).not.toContain("Page.loader");
  });
});

describe("createClientReference", () => {
  test("creates client reference object", () => {
    const ref = createClientReference("Counter.tsx", "Counter", ["Counter.a1b2.js"]);

    expect(ref.$$typeof).toBe(Symbol.for("react.client.reference"));
    expect(ref.$$id).toBe("Counter.tsx");
    expect(ref.$$name).toBe("Counter");
    expect(ref.$$bundles).toEqual(["Counter.a1b2.js"]);
  });

  test("creates reference with default export name", () => {
    const ref = createClientReference("Page.tsx", "default", ["Page.js"]);

    expect(ref.$$name).toBe("default");
  });
});
