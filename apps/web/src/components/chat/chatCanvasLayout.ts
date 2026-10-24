import {
  clampPreviewMiniPlayerPosition,
  resolvePreviewMiniPlayerFrame,
  type PreviewMiniPlayerFrame,
  type PreviewMiniPlayerObstacles,
} from "../preview/previewMiniPlayerLayout";
import type {
  PreviewMiniPlayerPosition,
  PreviewMiniPlayerSize,
  PreviewMiniPlayerState,
} from "~/previewMiniPlayerStore";

export interface ChatCanvasPreview {
  readonly key: string;
  readonly width: number | null;
  readonly position: PreviewMiniPlayerPosition | null;
  readonly source: PreviewMiniPlayerSize;
  readonly lastInteraction?: PreviewMiniPlayerState["lastInteraction"];
}

const GAP = 12;
export const DETAILS_CARD_CLEARANCE = 32;

export function resolveChatCanvasLayout({
  container,
  preview,
  padding = 48,
  maxChatWidth = 768,
  minChatWidth = 640,
  composerHeight = 0,
  detailsCard = null,
  leftCard = null,
  findBar = null,
}: {
  container: PreviewMiniPlayerSize;
  preview: ChatCanvasPreview | null;
  padding?: number;
  maxChatWidth?: number;
  minChatWidth?: number;
  composerHeight?: number;
  detailsCard?: PreviewMiniPlayerObstacles["detailsCard"];
  /** A card in the top-left gutter, which bounds the lane on the left as `detailsCard` does on the right. */
  leftCard?: PreviewMiniPlayerObstacles["detailsCard"];
  findBar?: PreviewMiniPlayerObstacles["detailsCard"];
}) {
  const centeredWidth = Math.max(0, Math.min(maxChatWidth, container.width - padding * 2));
  const laneRight = detailsCard
    ? detailsCard.left - DETAILS_CARD_CLEARANCE
    : container.width - padding;
  const laneLeft = leftCard ? leftCard.right + DETAILS_CARD_CLEARANCE : padding;
  // Keeps the lane's content off a left card; the end inset grows to match, so it stays centred.
  const insetStart = laneLeft - padding;
  const normalWidth = Math.max(0, Math.min(centeredWidth, laneRight - laneLeft));
  const normalLeft = Math.max(
    laneLeft,
    Math.min((container.width - normalWidth) / 2, laneRight - normalWidth),
  );
  let chat = {
    left: normalLeft,
    width: normalWidth,
    insetStart,
    insetEnd: Math.max(0, container.width - normalLeft * 2 - normalWidth + insetStart),
  };
  let frame: PreviewMiniPlayerFrame | null = null;
  let overlapsChat = false;
  if (preview && container.width > 0 && container.height > 0) {
    frame = resolvePreviewMiniPlayerFrame({ ...preview, container });
    // Reserve a readable chat lane only while it leaves room to drag. Otherwise
    // the container's right edge would pin the preview at every pointer position.
    const minimumPreviewX =
      preview.lastInteraction === "resize" ||
      container.width <= laneLeft + minChatWidth + frame.width + GAP * 2
        ? GAP
        : laneLeft + minChatWidth + GAP;
    if (preview.position === null) frame = { ...frame, y: container.height - frame.height - GAP };
    if (preview.lastInteraction === "resize" && composerHeight > 0) {
      const laneWidth = Math.min(normalWidth, minChatWidth);
      const transitionWidth = Math.max(GAP, normalWidth - laneWidth);
      const lift = Math.min(
        1,
        Math.max(0, (padding + normalWidth + GAP - frame.x) / transitionWidth),
      );
      if (lift > 0) {
        frame = resolvePreviewMiniPlayerFrame({
          width: frame.width,
          position: frame,
          source: preview.source,
          container: {
            ...container,
            height: Math.max(GAP * 2 + 1, container.height - composerHeight * lift),
          },
        });
      }
    }
    const findBarObstacles = findBar ? { detailsCard: findBar, composer: null } : undefined;
    const preferredFrame = {
      ...frame,
      ...clampPreviewMiniPlayerPosition(frame, container, frame, findBarObstacles, minimumPreviewX),
    };
    const dragObstacle =
      detailsCard && findBar
        ? {
            left: Math.min(detailsCard.left, findBar.left),
            right: Math.max(detailsCard.right, findBar.right),
            bottom: Math.max(detailsCard.bottom, findBar.bottom),
          }
        : (detailsCard ?? findBar);
    const cardObstacle = preview.lastInteraction === "resize" ? findBar : dragObstacle;
    frame = {
      ...frame,
      ...clampPreviewMiniPlayerPosition(
        frame,
        container,
        frame,
        { detailsCard: cardObstacle, composer: null },
        minimumPreviewX,
      ),
    };
    const chatBeside = (player: PreviewMiniPlayerFrame) => {
      const normalRight = normalLeft + normalWidth;
      if (player.x >= normalRight + GAP) return chat;
      const width = Math.min(maxChatWidth, player.x - GAP - laneLeft);
      if (width < minChatWidth) return null;
      const left = Math.min(normalLeft, player.x - GAP - width);
      return {
        left,
        width,
        insetStart,
        insetEnd: Math.max(0, container.width - left * 2 - width + insetStart),
      };
    };
    let nextChat = chatBeside(frame);
    if (!nextChat && detailsCard) {
      nextChat = chatBeside(preferredFrame);
      if (nextChat) frame = preferredFrame;
    }
    if (nextChat) chat = nextChat;
    else overlapsChat = true;
    if (overlapsChat && preview.lastInteraction === "resize") {
      const width = Math.min(normalWidth, minChatWidth);
      chat = {
        left: laneLeft,
        width,
        insetStart,
        insetEnd: Math.max(0, container.width - laneLeft * 2 - width + insetStart),
      };
    } else if (overlapsChat) {
      const obstacles = {
        detailsCard: cardObstacle,
        composer: { left: chat.left, right: chat.left + chat.width, height: composerHeight },
      };
      frame = resolvePreviewMiniPlayerFrame({ ...preview, container, obstacles });
      frame = {
        ...frame,
        ...clampPreviewMiniPlayerPosition(
          preview.position ?? { x: frame.x, y: container.height - frame.height - GAP },
          container,
          frame,
          obstacles,
          minimumPreviewX,
        ),
      };
      if (
        frame.x < obstacles.composer.right &&
        frame.x + frame.width > obstacles.composer.left &&
        frame.y + frame.height > container.height - composerHeight
      ) {
        frame = {
          ...frame,
          ...clampPreviewMiniPlayerPosition(
            frame,
            container,
            frame,
            { composer: obstacles.composer, detailsCard: findBar },
            minimumPreviewX,
          ),
        };
      }
    }
  }
  const overlapsDetailsCard = Boolean(
    frame &&
    detailsCard &&
    frame.x < detailsCard.right &&
    frame.x + frame.width > detailsCard.left &&
    frame.y < detailsCard.bottom,
  );
  return { chat, frame, overlapsChat, overlapsDetailsCard };
}
