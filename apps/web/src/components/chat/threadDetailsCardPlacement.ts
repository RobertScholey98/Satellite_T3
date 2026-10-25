import type { useChatCanvas } from "./ChatCanvasContext";
import { resolveThreadDetailsCardLayout } from "./threadDetailsCardLayout";

type ChatCanvas = NonNullable<ReturnType<typeof useChatCanvas>>;

/** The corner a caller picks for the details card, and how far below that corner's top it sits. */
export interface ThreadDetailsCardPlacement {
  readonly side: "left" | "right";
  readonly topInset: number;
}

/**
 * Where the details card goes for a caller's placement: `preferred` ignores the composer, `inline`
 * is null when the card has no room and opens as a popover. The factory workspace lays out around
 * the card by this same rule.
 */
export function resolveThreadDetailsCardPlacement(
  canvas: Pick<ChatCanvas, "container" | "lane" | "layout" | "detailsCardTopInset">,
  placement: ThreadDetailsCardPlacement | null,
) {
  const side = placement?.side ?? "right";
  const left = side === "left";
  // The find bar sits at the top right, so only a right-hand card moves down for it.
  const topInset = (left ? 0 : canvas.detailsCardTopInset) + (placement?.topInset ?? 0);
  return {
    side,
    preferred: resolveThreadDetailsCardLayout({
      container: canvas.container,
      lane: canvas.lane,
      frame: null,
      topInset,
      side,
    }),
    inline: resolveThreadDetailsCardLayout({
      container: canvas.container,
      lane: canvas.lane,
      frame: canvas.layout.frame,
      overlapsDetailsCard: !left && canvas.layout.overlapsDetailsCard,
      topInset,
      side,
    }),
  };
}
