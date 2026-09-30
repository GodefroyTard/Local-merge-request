/** A folder of the review file tree; `path` is repo-relative, `label` may span several compacted segments. */
export interface Folder<T> {
  kind: "folder";
  path: string;
  label: string;
  children: Entry<T>[];
}

export interface Leaf<T> {
  kind: "leaf";
  path: string;
  item: T;
}

export type Entry<T> = Folder<T> | Leaf<T>;

/** Groups repo-relative paths into folders, folders first, compacting single-folder chains like the SCM view. */
export function buildFileTree<T>(items: T[], pathOf: (item: T) => string): Entry<T>[] {
  const root: Folder<T> = { kind: "folder", path: "", label: "", children: [] };
  for (const item of items) {
    const segments = pathOf(item).split("/");
    let folder = root;
    for (const segment of segments.slice(0, -1)) {
      const p = folder.path ? `${folder.path}/${segment}` : segment;
      let next = folder.children.find((c): c is Folder<T> => c.kind === "folder" && c.path === p);
      if (!next) {
        next = { kind: "folder", path: p, label: segment, children: [] };
        folder.children.push(next);
      }
      folder = next;
    }
    folder.children.push({ kind: "leaf", path: pathOf(item), item });
  }
  return finish(root).children;
}

function finish<T>(folder: Folder<T>): Folder<T> {
  folder.children = folder.children.map((c) => (c.kind === "folder" ? compact(finish(c)) : c));
  folder.children.sort((a, b) => (a.kind === b.kind ? a.path.localeCompare(b.path) : a.kind === "folder" ? -1 : 1));
  return folder;
}

function compact<T>(folder: Folder<T>): Folder<T> {
  const [only] = folder.children;
  if (folder.children.length !== 1 || only.kind !== "folder") return folder;
  return { ...only, label: `${folder.label}/${only.label}` };
}
