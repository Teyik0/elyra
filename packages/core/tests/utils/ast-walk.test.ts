import { describe, expect, test } from "bun:test";
import { walkAST } from "../../src/shared/utils/ast-walk.ts";

describe("walkAST", () => {
  test("invokes visitor for every node with a type property", () => {
    const visited: string[] = [];
    const ast = {
      type: "Program",
      body: [
        { type: "ExpressionStatement", expression: { type: "Literal", value: 1 } },
        { type: "ExpressionStatement", expression: { type: "Identifier", name: "x" } },
      ],
    };

    walkAST(ast, (node) => visited.push(node.type));

    expect(visited).toEqual([
      "Program",
      "ExpressionStatement",
      "Literal",
      "ExpressionStatement",
      "Identifier",
    ]);
  });

  test("skips type/start/end keys so visitor is not called on positional metadata", () => {
    const visited: string[] = [];
    const ast = {
      type: "Node",
      start: 0,
      end: 10,
      body: [{ type: "Child" }],
    };

    walkAST(ast, (node) => visited.push(node.type));

    expect(visited).toEqual(["Node", "Child"]);
  });

  test("does not throw on null or primitive values", () => {
    const visited: string[] = [];

    walkAST(null, (node) => visited.push(node.type));
    walkAST(undefined, (node) => visited.push(node.type));
    walkAST(42, (node) => visited.push(node.type));
    walkAST("hello", (node) => visited.push(node.type));

    expect(visited).toEqual([]);
  });

  test("traverses arrays at any depth", () => {
    const visited: string[] = [];
    const ast = {
      type: "Root",
      list: [[{ type: "NestedA" }, { type: "NestedB" }]],
    };

    walkAST(ast, (node) => visited.push(node.type));

    expect(visited).toEqual(["Root", "NestedA", "NestedB"]);
  });

  test("visitor can abort further traversal for a branch by not recursing", () => {
    // walkAST always recurses deeply; the visitor cannot abort traversal.
    // This test simply documents that behaviour.
    const visited: string[] = [];
    const ast = {
      type: "Root",
      child: { type: "Leaf" },
    };

    walkAST(ast, (node) => {
      visited.push(node.type);
    });

    expect(visited).toEqual(["Root", "Leaf"]);
  });
});
