import { marked, type Token, type Tokens } from "marked";
import type { ReactNode } from "react";

/** A URL, a Windows absolute path, or a relative path that ends in a file name with an
 * extension (tools/record/run.mjs). Paths with spaces are only recognised in backticks. */
const LINK =
  /(https?:\/\/[^\s<>"'`]+)|([A-Za-z]:[\\/][^\s<>"'`|?*]+)|((?:[\w.-]+[\\/])+[\w.-]+\.[A-Za-z0-9]{1,8}\b)/g;

const TRAILING = /[.,;:!?)\]}]+$/;

interface Props {
  text: string;
  onOpenPath: (path: string) => void;
}

/** Text with its URLs and file paths made into links, and `code` spans shown as code. */
export function Linkify({ text, onOpenPath }: Props) {
  const out: ReactNode[] = [];
  // Backtick spans first: a whole span that is a path or URL becomes one link.
  text.split(/(`[^`\n]+`)/g).forEach((part, i) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      const inner = part.slice(1, -1);
      out.push(
        <code key={i} className="inline-code">
          {looksLikeLink(inner) ? link(inner, `${i}`, onOpenPath) : inner}
        </code>,
      );
    } else {
      out.push(...linkify(part, `${i}`, onOpenPath));
    }
  });
  return <>{out}</>;
}

function looksLikeLink(s: string): boolean {
  return (
    /^https?:\/\//.test(s) ||
    /^[A-Za-z]:[\\/]/.test(s) ||
    // Inside backticks a path may contain spaces: "videos/Updates of ACR videos/PLAN.md".
    (/[\\/]/.test(s) && /\.[A-Za-z0-9]{1,8}$/.test(s) && !/^\s|\s$/.test(s))
  );
}

function linkify(text: string, key: string, onOpenPath: (path: string) => void): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(LINK)) {
    let target = m[0];
    const trailing = TRAILING.exec(target)?.[0] ?? "";
    target = target.slice(0, target.length - trailing.length);
    if (!target) continue;
    out.push(text.slice(last, m.index));
    out.push(link(target, `${key}-${m.index}`, onOpenPath));
    last = m.index + target.length;
  }
  out.push(text.slice(last));
  return out;
}

function link(target: string, key: string, onOpenPath: (path: string) => void): ReactNode {
  if (/^https?:\/\//.test(target)) {
    return (
      <a key={key} className="text-link" href={target} target="_blank" rel="noreferrer">
        {target}
      </a>
    );
  }
  return (
    <a
      key={key}
      className="text-link"
      href="#"
      title={target}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onOpenPath(target);
      }}
    >
      {target}
    </a>
  );
}

/**
 * Markdown, as Claude writes it, shown as styled text: headings, emphasis, lists, tables, code.
 * Raw HTML in it is shown as text. URLs and file paths become links, as in `Linkify`.
 */
export function Markdown({
  text,
  onOpenPath,
  imageUrl,
  className = "md",
}: Props & {
  /** Where an image the Markdown links to is served from. Without it, images show as links. */
  imageUrl?: (src: string) => string;
  className?: string;
}) {
  // Chat messages keep their line breaks; documents are standard Markdown.
  const tokens = marked.lexer(text, { gfm: true, breaks: !imageUrl });
  const open: Open = Object.assign((path: string) => onOpenPath(path), { imageUrl });
  return <div className={className}>{blocks(tokens, "b", open)}</div>;
}

/** Opens a path, and knows where images are served from when they're shown. */
type Open = ((path: string) => void) & { imageUrl?: (src: string) => string };

function blocks(tokens: Token[], key: string, open: Open): ReactNode[] {
  return tokens.map((t, i) => block(t, `${key}.${i}`, open));
}

function block(t: Token, key: string, open: Open): ReactNode {
  const tok = t as Tokens.Generic;
  switch (t.type) {
    case "space":
    case "def":
      return null;
    case "heading": {
      const h = t as Tokens.Heading;
      return (
        <div key={key} className={`md-h md-h${Math.min(h.depth, 4)}`}>
          {inline(h.tokens, key, open)}
        </div>
      );
    }
    case "paragraph":
      return <p key={key}>{inline((t as Tokens.Paragraph).tokens, key, open)}</p>;
    case "code":
      return (
        <pre key={key} className="md-code">
          <code>{(t as Tokens.Code).text}</code>
        </pre>
      );
    case "blockquote":
      return (
        <blockquote key={key}>{blocks((t as Tokens.Blockquote).tokens, key, open)}</blockquote>
      );
    case "hr":
      return <hr key={key} />;
    case "list": {
      const l = t as Tokens.List;
      const items = l.items.map((item, i) => (
        <li key={i}>
          {item.task && <input type="checkbox" checked={item.checked} disabled />}
          {blocks(item.tokens, `${key}.${i}`, open)}
        </li>
      ));
      return l.ordered ? (
        <ol key={key} start={l.start === "" ? undefined : l.start}>
          {items}
        </ol>
      ) : (
        <ul key={key}>{items}</ul>
      );
    }
    case "table": {
      const tb = t as Tokens.Table;
      const cell = (c: Tokens.TableCell, i: number, Tag: "th" | "td") => (
        <Tag key={i} style={c.align ? { textAlign: c.align } : undefined}>
          {inline(c.tokens, `${key}.${i}`, open)}
        </Tag>
      );
      return (
        <div key={key} className="md-table">
          <table>
            <thead>
              <tr>{tb.header.map((c, i) => cell(c, i, "th"))}</tr>
            </thead>
            <tbody>
              {tb.rows.map((row, r) => (
                <tr key={r}>{row.map((c, i) => cell(c, i, "td"))}</tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    case "text":
      // A list item's text: inline content without a paragraph around it.
      return (
        <span key={key}>
          {tok.tokens ? inline(tok.tokens, key, open) : linkify(tok.text as string, key, open)}
        </span>
      );
    default:
      return <p key={key}>{inline([t], key, open)}</p>;
  }
}

function inline(tokens: Token[], key: string, open: Open): ReactNode[] {
  return tokens.map((t, i) => {
    const k = `${key}.${i}`;
    const tok = t as Tokens.Generic;
    switch (t.type) {
      case "text":
        return tok.tokens ? (
          <span key={k}>{inline(tok.tokens, k, open)}</span>
        ) : (
          <span key={k}>{linkify(tok.text as string, k, open)}</span>
        );
      case "escape":
        return (t as Tokens.Escape).text;
      case "strong":
        return <strong key={k}>{inline((t as Tokens.Strong).tokens, k, open)}</strong>;
      case "em":
        return <em key={k}>{inline((t as Tokens.Em).tokens, k, open)}</em>;
      case "del":
        return <del key={k}>{inline((t as Tokens.Del).tokens, k, open)}</del>;
      case "br":
        return <br key={k} />;
      case "codespan": {
        const code = (t as Tokens.Codespan).text;
        return (
          <code key={k} className="inline-code">
            {looksLikeLink(code) ? link(code, k, open) : code}
          </code>
        );
      }
      case "link":
      case "image": {
        const l = t as Tokens.Link;
        if (t.type === "image" && open.imageUrl && !/^https?:\/\//.test(l.href)) {
          return <img key={k} className="md-image" src={open.imageUrl(l.href)} alt={l.text} />;
        }
        const label = l.tokens?.length ? inline(l.tokens, k, open) : l.text;
        return /^https?:\/\//.test(l.href) ? (
          <a key={k} className="text-link" href={l.href} target="_blank" rel="noreferrer">
            {label}
          </a>
        ) : (
          <a
            key={k}
            className="text-link"
            href="#"
            title={l.href}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              open(l.href);
            }}
          >
            {label}
          </a>
        );
      }
      default:
        return <span key={k}>{tok.raw}</span>;
    }
  });
}
