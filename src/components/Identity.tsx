import { useEffect, useRef, useState } from "react";
import type { ClaudeAuth } from "../../shared/types.ts";
import { Avatar } from "./Avatar.tsx";

interface Props {
  name: string;
  /** git's user.email; absent when the name was given with `--user`. */
  email?: string;
  auth: ClaudeAuth | null;
  onLogin: () => void;
}

/** The reviewer's own avatar, which opens who HowReel and Claude take them to be. */
export function Identity({ name, email, auth, onLogin }: Props) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  // A press anywhere outside closes it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [open]);

  return (
    <div className="settings" ref={boxRef}>
      <button
        className="avatar-btn"
        aria-expanded={open}
        aria-label={name}
        onClick={() => setOpen((o) => !o)}
      >
        <Avatar name={name} />
      </button>
      {open && (
        <div className="settings-pop" data-testid="identity">
          <div className="key-field">
            <span className="eyebrow">Git</span>
            <div className="identity-line">{email ?? name}</div>
          </div>
          <div className="key-field">
            <span className="eyebrow">Claude</span>
            {auth?.loggedIn ? (
              <>
                {auth.email && <div className="identity-line">{auth.email}</div>}
                {(auth.orgName || auth.subscriptionType) && (
                  <div className="identity-line dim">
                    {[auth.orgName, auth.subscriptionType].filter(Boolean).join(" · ")}
                  </div>
                )}
              </>
            ) : auth?.installed === false ? (
              <a
                className="btn btn-primary"
                href="https://claude.com/claude-code"
                target="_blank"
                rel="noreferrer"
              >
                Install Claude Code
              </a>
            ) : (
              auth && (
                <button className="btn btn-primary" onClick={onLogin}>
                  Log in to Claude
                </button>
              )
            )}
          </div>
        </div>
      )}
    </div>
  );
}
