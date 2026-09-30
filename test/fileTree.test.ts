import { expect, test } from "vitest";
import { buildFileTree, Entry } from "../src/extension/fileTree";

const shape = (entries: Entry<string>[]): unknown[] =>
  entries.map((e) => (e.kind === "leaf" ? e.item : { [e.label]: shape(e.children) }));

test("groups files into folders, folders first, sorted", () => {
  const tree = buildFileTree(["pyproject.toml", "tests/unit/b.py", "tests/evals/a.py", "tests/evals/README.md", "a.txt"], (p) => p);
  expect(shape(tree)).toEqual([
    { tests: [{ evals: ["tests/evals/a.py", "tests/evals/README.md"] }, { unit: ["tests/unit/b.py"] }] },
    "a.txt",
    "pyproject.toml",
  ]);
});

test("compacts chains of single folders and keeps the full folder path", () => {
  const tree = buildFileTree(["src/core/deep/x.ts", "src/core/deep/y.ts"], (p) => p);
  expect(shape(tree)).toEqual([{ "src/core/deep": ["src/core/deep/x.ts", "src/core/deep/y.ts"] }]);
  expect(tree[0]).toMatchObject({ kind: "folder", path: "src/core/deep" });
});

test("does not compact a folder that also holds files", () => {
  const tree = buildFileTree(["src/a.ts", "src/core/b.ts"], (p) => p);
  expect(shape(tree)).toEqual([{ src: [{ core: ["src/core/b.ts"] }, "src/a.ts"] }]);
});
