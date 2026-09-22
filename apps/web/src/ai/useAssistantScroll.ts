import { useLayoutEffect, useRef } from "react";
import { isAssistantScrollPinned } from "./assistantInput";

/** Follow streaming output only while the reader remains near the latest message. */
export function useAssistantScroll(revision: unknown, hasMessages: boolean) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    if (!hasMessages) body.scrollTop = 0;
    else if (pinned.current) body.scrollTop = body.scrollHeight;
  }, [revision, hasMessages]);
  return {
    bodyRef,
    onScroll: () => {
      if (bodyRef.current) pinned.current = isAssistantScrollPinned(bodyRef.current);
    },
    follow: () => { pinned.current = true; },
  };
}
