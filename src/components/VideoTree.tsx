import { useEffect, useRef, useState } from "react";
import { isDocument } from "../format.ts";
import type { TreeNode } from "../../shared/types.ts";
import { AgentStatusBadge } from "./AgentStatusBadge.tsx";
import { FolderPicker } from "./FolderPicker.tsx";
import {
  CheckIcon,
  ChevronIcon,
  FileIcon,
  FolderIcon,
  PencilIcon,
  PlayIcon,
  ProjectFolderIcon,
  TrashIcon,
} from "./icons.tsx";

interface Props {
  rootName: string;
  rootPath: string | null;
  recent: string[];
  onBrowse: () => Promise<void>;
  onChooseRoot: (path: string) => Promise<void>;
  tree: TreeNode[];
  /** The selected video, or folder. */
  selected?: string;
  onSelect: (path: string) => void;
  onSelectFolder: (path: string) => void;
  onMakeProject: (folder: string) => void;
  onReveal: (path: string) => void;
  /** Opens a file in its default app. */
  onOpen: (path: string) => void;
  /** Renames a file within its folder. */
  onRename: (path: string, name: string) => Promise<void>;
  /** Moves a file to the Recycle Bin. */
  onDelete: (path: string) => void;
}

function hasVideo(node: TreeNode): boolean {
  return node.kind === "video" || (node.children ?? []).some(hasVideo);
}

function unresolvedBelow(node: TreeNode): number {
  if (node.kind === "video") return node.unresolved ?? 0;
  return (node.children ?? []).reduce((sum, n) => sum + unresolvedBelow(n), 0);
}

export function VideoTree(props: Props) {
  const { tree, selected, onSelect } = props;
  // Folders the user has opened or closed, away from how they start out.
  const [toggled, setToggled] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ x: number; y: number; node: TreeNode } | null>(null);
  // The file whose name is being edited.
  const [renaming, setRenaming] = useState<string | null>(null);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", close);
    };
  }, [menu]);

  const toggle = (path: string) =>
    setToggled((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  // A folder starts out open when there is a video somewhere inside it.
  const isOpen = (node: TreeNode) => hasVideo(node) !== toggled.has(node.path);

  // Open the folders above whatever gets selected, so it can be seen.
  useEffect(() => {
    if (!selected) return;
    const above: TreeNode[] = [];
    const find = (nodes: TreeNode[]): boolean =>
      nodes.some((n) => {
        if (n.path === selected) return true;
        if (n.kind === "folder" && find(n.children ?? [])) return above.push(n) > 0;
        return false;
      });
    if (!find(tree)) return;
    const closed = above.filter((n) => hasVideo(n) === toggled.has(n.path));
    if (closed.length)
      setToggled(
        (prev) =>
          new Set(
            [...prev]
              .filter((p) => !closed.some((n) => n.path === p))
              .concat(closed.filter((n) => !hasVideo(n)).map((n) => n.path)),
          ),
      );
    // Only when the selection changes or the tree first arrives, not when the user closes a folder.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, tree.length > 0]);

  const rows: { node: TreeNode; depth: number; open: boolean }[] = [];
  const walk = (nodes: TreeNode[], depth: number) => {
    for (const node of nodes) {
      const open = node.kind === "folder" && isOpen(node);
      rows.push({ node, depth, open });
      if (open) walk(node.children ?? [], depth + 1);
    }
  };
  walk(tree, 0);

  return (
    <aside className="sidebar">
      <FolderPicker
        rootName={props.rootName}
        rootPath={props.rootPath}
        recent={props.recent}
        onBrowse={props.onBrowse}
        onChoose={props.onChooseRoot}
      />
      <div className="tree" role="tree">
        {rows.map(({ node, depth, open }) => {
          const isFolder = node.kind === "folder";
          // Documents open in the middle column; other files only in their own apps.
          const isFile = node.kind === "file" && !isDocument(node.path);
          const isSelected = node.path === selected;
          return (
            <div
              key={node.path}
              role="treeitem"
              aria-selected={isSelected}
              data-path={node.path}
              title={
                node.mtime
                  ? `Modified ${new Date(node.mtime).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`
                  : undefined
              }
              className={`tree-row${isSelected ? " selected" : ""}${isFolder ? " folder" : ""}${isFile ? " file" : ""}${node.step ? " planning" : ""}${node.project ? " project" : ""}`}
              style={{ paddingLeft: 8 + depth * 18 }}
              onClick={() => {
                if (isFile) return;
                if (!isFolder) return onSelect(node.path);
                // A folder opens when chosen; choosing it again closes it.
                if (isSelected || !open) toggle(node.path);
                props.onSelectFolder(node.path);
              }}
              onDoubleClick={() => isFile && props.onOpen(node.path)}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, node });
              }}
            >
              {isFolder ? (
                <>
                  {node.children?.length ? (
                    <span
                      className="tree-chevron"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggle(node.path);
                      }}
                    >
                      <ChevronIcon className="tree-icon muted" open={open} />
                    </span>
                  ) : (
                    <span className="tree-icon-space" />
                  )}
                  {node.project ? (
                    <ProjectFolderIcon className="tree-icon go" />
                  ) : (
                    <FolderIcon className="tree-icon muted" />
                  )}
                </>
              ) : node.step ? (
                <span className="tree-step" aria-label={`Step ${node.step}`}>
                  {node.step}
                </span>
              ) : isFile ? (
                <FileIcon className="tree-icon muted" />
              ) : node.kind === "file" ? (
                <FileIcon className="tree-icon accent" />
              ) : (
                <PlayIcon className="tree-icon accent" />
              )}
              {renaming === node.path ? (
                <RenameField
                  name={node.name}
                  onDone={async (name) => {
                    if (name !== null && name !== node.name) await props.onRename(node.path, name);
                    setRenaming(null);
                  }}
                />
              ) : (
                <span className="tree-label">{node.name}</span>
              )}
              {node.approved && <CheckIcon className="tree-approved" size={13} />}
              {node.project && node.agentStatus && (
                <AgentStatusBadge status={node.agentStatus} withLabel={false} />
              )}
              {(() => {
                const count = isFolder
                  ? open
                    ? 0
                    : unresolvedBelow(node)
                  : (node.unresolved ?? 0);
                return count > 0 && <span className="count-badge">{count}</span>;
              })()}
            </div>
          );
        })}
      </div>
      {menu && (
        <div
          className="context-menu"
          role="menu"
          style={{ left: menu.x, top: menu.y }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button
            role="menuitem"
            onClick={() => {
              props.onReveal(menu.node.path);
              setMenu(null);
            }}
          >
            Show in File Explorer
          </button>
          {menu.node.kind === "folder" && (
            <button
              role="menuitem"
              disabled={menu.node.project}
              onClick={() => {
                props.onMakeProject(menu.node.path);
                setMenu(null);
              }}
            >
              Make project here
            </button>
          )}
          {menu.node.kind !== "folder" && (
            <>
              <button
                role="menuitem"
                onClick={() => {
                  setRenaming(menu.node.path);
                  setMenu(null);
                }}
              >
                <PencilIcon size={13} />
                Rename
              </button>
              <button
                role="menuitem"
                className="danger"
                onClick={() => {
                  props.onDelete(menu.node.path);
                  setMenu(null);
                }}
              >
                <TrashIcon />
                Delete File
              </button>
            </>
          )}
        </div>
      )}
    </aside>
  );
}

/** Edits a file's name in place: Enter or leaving the field keeps it, Escape cancels. The part
 * before the extension starts selected. */
function RenameField({
  name,
  onDone,
}: {
  name: string;
  onDone: (name: string | null) => Promise<void>;
}) {
  const [value, setValue] = useState(name);
  const done = useRef(false);
  const finish = (result: string | null) => {
    if (done.current) return;
    done.current = true;
    void onDone(result?.trim() || null);
  };
  return (
    <input
      className="tree-rename"
      value={value}
      autoFocus
      onFocus={(e) => {
        const dot = name.lastIndexOf(".");
        e.currentTarget.setSelectionRange(0, dot > 0 ? dot : name.length);
      }}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(value);
        if (e.key === "Escape") finish(null);
      }}
      onBlur={() => finish(value)}
    />
  );
}
