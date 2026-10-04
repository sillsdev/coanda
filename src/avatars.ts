import { createContext } from "react";

/** Picture URLs by person's name, from the server. */
export const AvatarsContext = createContext<Record<string, string>>({});
