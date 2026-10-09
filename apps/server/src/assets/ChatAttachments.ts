import {
  ChatAttachmentId,
  PersistChatAttachmentsError,
  type PersistChatAttachmentsInput,
  type PersistChatAttachmentsResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Base64 from "effect/encoding/Base64";

import { attachmentRelativePath, createDeterministicAttachmentId } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import { parseBase64DataUrl } from "../imageMime.ts";

export class ChatAttachments extends Context.Service<
  ChatAttachments,
  {
    readonly persist: (
      input: PersistChatAttachmentsInput,
    ) => Effect.Effect<PersistChatAttachmentsResult, PersistChatAttachmentsError>;
  }
>()("t3/assets/ChatAttachments") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const persist = Effect.fn("ChatAttachments.persist")(function* (
    input: PersistChatAttachmentsInput,
  ) {
    const attachments = yield* Effect.forEach(
      input.attachments.map((attachment, index) => ({ attachment, index })),
      Effect.fn("ChatAttachments.persistImage")(function* ({ attachment, index }) {
        const parsed = parseBase64DataUrl(attachment.dataUrl);
        if (parsed === null || parsed.mimeType !== attachment.mimeType.toLowerCase()) {
          return yield* new PersistChatAttachmentsError({
            message: `Attachment ${attachment.name} has an invalid image payload.`,
          });
        }
        const bytes = yield* Effect.fromResult(Base64.decode(parsed.base64)).pipe(
          Effect.mapError(
            (cause) =>
              new PersistChatAttachmentsError({
                message: `Attachment ${attachment.name} is not valid base64.`,
                cause,
              }),
          ),
        );
        if (bytes.byteLength !== attachment.sizeBytes) {
          return yield* new PersistChatAttachmentsError({
            message: `Attachment ${attachment.name} size does not match its payload.`,
          });
        }
        const rawId = createDeterministicAttachmentId(
          input.threadId,
          `${input.messageId}:${index}`,
        );
        if (rawId === null) {
          return yield* new PersistChatAttachmentsError({
            message: "Could not allocate an attachment identifier.",
          });
        }
        const persisted = {
          type: "image" as const,
          id: ChatAttachmentId.make(rawId),
          name: attachment.name,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
        };
        yield* fileSystem
          .writeFile(path.join(config.attachmentsDir, attachmentRelativePath(persisted)!), bytes)
          .pipe(
            Effect.mapError(
              (cause) =>
                new PersistChatAttachmentsError({
                  message: `Could not persist attachment ${attachment.name}.`,
                  cause,
                }),
            ),
          );
        return persisted;
      }),
      { concurrency: 2 },
    );
    return { attachments };
  });

  return ChatAttachments.of({ persist });
});

export const layer = Layer.effect(ChatAttachments, make);
