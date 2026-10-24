/**
 * Migration carried an old full-text `roles/lead.md` or `roles/manager.md` override into a lead's
 * or manager's added instructions verbatim, so that brief now holds the built-in protocol twice.
 * The protocol's first heading on a line of its own is the tell.
 */
const PROTOCOL_HEADINGS = { lead: "# Lead", manager: "# Engineering manager" } as const;

export const PROTOCOL_COPY_WARNING =
  "These instructions look like a full copy of the built-in protocol, which the brief already includes. Keep only what you added.";

export function looksLikeProtocolCopy(kind: "lead" | "manager", instructions: string): boolean {
  const heading = PROTOCOL_HEADINGS[kind];
  return instructions.split(/\r?\n/).some((line) => line.trim() === heading);
}
