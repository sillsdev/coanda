import { useContext, useState } from "react";
import { AvatarsContext } from "../avatars.ts";
import { avatarColor, initials } from "../format.ts";

/** A person's Gravatar picture, or their initials when they have none. */
export function Avatar({ name, className = "" }: { name: string; className?: string }) {
  const url = useContext(AvatarsContext)[name];
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <span className={`avatar ${className}`} title={name} style={{ background: avatarColor(name) }}>
      {url && failed !== url ? (
        <img src={url} alt="" onError={() => setFailed(url)} />
      ) : (
        initials(name)
      )}
    </span>
  );
}
