import { useEffect } from "react";
import { markStartup } from "../startupTimeline";

/** Renders nothing; marks the moment the authenticated workspace actually mounted. */
export function StartupInteractiveMark(): null {
  useEffect(() => { markStartup("editor-interactive"); }, []);
  return null;
}
