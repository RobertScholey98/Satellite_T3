import type { TurnAttachmentAdapter } from "@t3tools/client-runtime/turn-delivery";

import type {
  ComposerFileAttachment,
  ComposerImageAttachment,
  ComposerThreadTarget,
} from "../composerDraftStore";
import {
  awaitAttachmentUploads,
  getUploadedAttachments,
  startAttachmentUpload,
} from "./attachmentUploadQueue";
import { readFileAsDataUrl } from "./imageCompression";

export type ComposerTurnAttachment = ComposerImageAttachment | ComposerFileAttachment;

/**
 * Sends composer attachments through this client's upload queue, or reads image bytes inline for
 * a server without uploads. `draftTarget` lets a background completion persist a file's upload id
 * on the draft that owns it.
 */
export function composerTurnAttachments(
  draftTarget?: ComposerThreadTarget,
): TurnAttachmentAdapter<ComposerTurnAttachment> {
  return {
    prepare: async ({ environmentId, attachments, upload }) => {
      if (!upload) {
        return Promise.all(
          attachments.map(async (attachment) => {
            if (attachment.type !== "image" || attachment.file === null) {
              throw new Error("This server does not support file attachments.");
            }
            return {
              type: "image" as const,
              id: attachment.id,
              name: attachment.name,
              mimeType: attachment.mimeType,
              sizeBytes: attachment.sizeBytes,
              dataUrl: await readFileAsDataUrl(attachment.file),
              ...(attachment.source ? { source: attachment.source } : {}),
            };
          }),
        );
      }
      for (const attachment of attachments) {
        startAttachmentUpload({
          environmentId,
          image: attachment,
          ...(draftTarget === undefined ? {} : { draftTarget }),
        });
      }
      await awaitAttachmentUploads(attachments.map((attachment) => attachment.id));
      const uploaded = getUploadedAttachments({ environmentId, images: attachments });
      if (uploaded === null) throw new Error("Retry or remove failed uploads before sending.");
      return uploaded;
    },
  };
}
