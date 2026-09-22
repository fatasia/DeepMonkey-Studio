/** Enter confirms IME candidates; only an unmodified, non-composing Enter sends. */
export function shouldSendAssistantInput(event: {
  key: string;
  shiftKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
}, composing = false): boolean {
  return event.key === "Enter" && !event.shiftKey && !composing && !event.isComposing && event.keyCode !== 229;
}

export function isAssistantScrollPinned(element: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= 48;
}
