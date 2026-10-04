import type { ReactNode } from "react";
import { Avatar } from "./Avatar.tsx";

interface Props {
  rootName: string;
  video?: string;
  reviewers: string[];
  children?: ReactNode;
}

export function Header({ rootName, video, reviewers, children }: Props) {
  const crumbs = [rootName, ...(video ? video.split("/") : [])].filter(Boolean);
  return (
    <header className="app-header">
      <div className="brand">
        <img src="/logo.svg" alt="" className="brand-logo" />
        <span className="brand-name">Coanda</span>
      </div>
      <div className="crumbs" data-testid="breadcrumb">
        {crumbs.map((c, i) => (
          <span key={i} className="crumbs-part">
            {i > 0 && <span className="crumbs-sep">/</span>}
            <span className={i === crumbs.length - 1 ? "crumbs-current" : undefined}>{c}</span>
          </span>
        ))}
      </div>
      {reviewers.length > 0 && (
        <div className="reviewers">
          <div className="avatar-stack">
            {reviewers.map((name) => (
              <Avatar key={name} name={name} />
            ))}
          </div>
        </div>
      )}
      {children}
    </header>
  );
}
