import type { PreviewMiniPlayerFrame } from "../preview/previewMiniPlayerLayout";
import { DETAILS_CARD_CLEARANCE } from "./chatCanvasLayout";

export const THREAD_DETAILS_CARD_GAP = 12;
// Keep in sync with --thread-details-panel-width.
export const THREAD_DETAILS_CARD_WIDTH = 280;

export function resolveThreadDetailsCardDensity(
  height: number,
  content: { full: number; compact: number },
) {
  if (content.full === 0 || content.full <= height) return "full";
  if (content.compact === 0 || content.compact <= height) return "compact";
  return "essential";
}

export function resolveThreadDetailsCardLayout({
  container,
  lane,
  frame,
  overlapsDetailsCard = false,
  topInset = 0,
  side = "right",
}: {
  container: { width: number; height: number };
  lane: { padding: number; minChatWidth: number };
  frame: PreviewMiniPlayerFrame | null;
  overlapsDetailsCard?: boolean;
  topInset?: number;
  /** `left` puts the card in the top-left gutter; whoever asks for it has checked that it fits. */
  side?: "left" | "right";
}) {
  const gap = THREAD_DETAILS_CARD_GAP;
  const width = THREAD_DETAILS_CARD_WIDTH;
  const x = side === "left" ? gap : container.width - width - gap;
  if (side === "right" && x - DETAILS_CARD_CLEARANCE - lane.padding < lane.minChatWidth)
    return null;
  const y = gap + topInset;
  const height =
    overlapsDetailsCard && frame && frame.x + frame.width > x - gap && frame.x < x + width + gap
      ? Math.min(container.height - y - gap, frame.y - y - gap)
      : container.height - y - gap;
  if (height < 160) return null;
  return {
    x,
    right: container.width - x - width,
    width,
    y,
    height,
  } as const;
}
