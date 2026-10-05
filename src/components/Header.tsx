import type { ReactNode } from "react";
import { Avatar } from "./Avatar.tsx";

interface Props {
  reviewers: string[];
  children?: ReactNode;
}

export function Header({ reviewers, children }: Props) {
  return (
    <header className="app-header">
      <div className="brand">
        <img src="/logo.svg" alt="" className="brand-logo" />
        <span className="brand-name">HowReel</span>
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
