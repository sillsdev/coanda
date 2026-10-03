import { useState } from "react";
import type { TreeNode } from "../../shared/types.ts";
import { ChevronIcon, FolderIcon, PlayIcon, SearchIcon } from "./icons.tsx";

interface Props {
  rootName: string;
  rootPath: string;
  tree: TreeNode[];
  selected?: string;
  onSelect: (path: string) => void;
}

function filterTree(nodes: TreeNode[], text: string): TreeNode[] {
  if (!text) return nodes;
  const needle = text.toLowerCase();
  return nodes.flatMap((n) => {
    if (n.kind === "video") return n.path.toLowerCase().includes(needle) ? [n] : [];
    const children = filterTree(n.children ?? [], text);
    return children.length ? [{ ...n, children }] : [];
  });
}

export function VideoTree({ rootName, rootPath, tree, selected, onSelect }: Props) {
  const [filter, setFilter] = useState("");
  const [closed, setClosed] = useState<Set<string>>(new Set());

  const toggle = (path: string) =>
    setClosed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const rows: { node: TreeNode; depth: number }[] = [];
  const walk = (nodes: TreeNode[], depth: number) => {
    for (const node of nodes) {
      rows.push({ node, depth });
      if (node.kind === "folder" && (filter || !closed.has(node.path)))
        walk(node.children ?? [], depth + 1);
    }
  };
  walk(filterTree(tree, filter.trim()), 0);

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <div className="eyebrow">Folder</div>
        <div className="mono sidebar-root">{rootName}</div>
        <div className="sidebar-path" title={rootPath}>
          {rootPath}
        </div>
      </div>
      <div className="filter">
        <input
          className="field"
          placeholder="Filter videos"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <SearchIcon className="filter-icon" />
      </div>
      <div className="tree" role="tree">
        {rows.length === 0 && <div className="tree-empty">No videos found</div>}
        {rows.map(({ node, depth }) => {
          const isFolder = node.kind === "folder";
          const isSelected = node.path === selected;
          return (
            <div
              key={node.path}
              role="treeitem"
              aria-selected={isSelected}
              data-path={node.path}
              className={`tree-row${isSelected ? " selected" : ""}${isFolder ? " folder" : ""}`}
              style={{ paddingLeft: 8 + depth * 18 }}
              onClick={() => (isFolder ? toggle(node.path) : onSelect(node.path))}
            >
              {isFolder ? (
                <>
                  <ChevronIcon
                    className="tree-icon muted"
                    open={filter !== "" || !closed.has(node.path)}
                  />
                  <FolderIcon className="tree-icon muted" />
                </>
              ) : (
                <PlayIcon className="tree-icon accent" />
              )}
              <span className="tree-label">{node.name}</span>
              {!!node.unresolved && <span className="count-badge">{node.unresolved}</span>}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
