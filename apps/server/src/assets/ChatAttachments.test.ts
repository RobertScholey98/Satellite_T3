import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { MessageId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { attachmentRelativePath } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as ChatAttachments from "./ChatAttachments.ts";

const layer = ChatAttachments.layer.pipe(
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "satellite-chat-attachments-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);
const input = {
  threadId: ThreadId.make("attachment-thread"),
  messageId: MessageId.make("attachment-message"),
  attachments: [
    {
      type: "image" as const,
      name: "capture.png",
      mimeType: "image/png",
      sizeBytes: 3,
      dataUrl: "data:image/png;base64,AQID",
    },
  ],
};

it.layer(layer)("ChatAttachments", (it) => {
  it.effect(
    "persists exact bytes with stable IDs on retries and distinct IDs per message slot",
    () =>
      Effect.gen(function* () {
        const service = yield* ChatAttachments.ChatAttachments;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* ServerConfig.ServerConfig;
        const first = yield* service.persist(input);
        const retry = yield* service.persist(input);
        expect(retry).toEqual(first);
        expect(first.attachments[0]).toMatchObject({
          type: "image",
          name: "capture.png",
          mimeType: "image/png",
          sizeBytes: 3,
        });
        const attachment = first.attachments[0]!;
        expect(
          Array.from(
            yield* fileSystem.readFile(
              path.join(config.attachmentsDir, attachmentRelativePath(attachment)!),
            ),
          ),
        ).toEqual([1, 2, 3]);
        const other = yield* service.persist({
          ...input,
          messageId: MessageId.make("other-message"),
        });
        const multiple = yield* service.persist({
          ...input,
          attachments: [input.attachments[0]!, input.attachments[0]!],
        });
        expect(other.attachments[0]?.id).not.toBe(attachment.id);
        expect(multiple.attachments[1]?.id).not.toBe(attachment.id);
      }),
  );

  describe("invalid uploads", () => {
    it.effect.each([
      [{ dataUrl: "not a data URL" }, "has an invalid image payload."],
      [{ dataUrl: "data:image/jpeg;base64,AQID" }, "has an invalid image payload."],
      [{ dataUrl: "data:image/png;base64,!!!!" }, "has an invalid image payload."],
      [{ sizeBytes: 4 }, "size does not match its payload."],
    ] as const)("rejects %j without writing a file", ([patch, message]) =>
      Effect.gen(function* () {
        const service = yield* ChatAttachments.ChatAttachments;
        const fileSystem = yield* FileSystem.FileSystem;
        const config = yield* ServerConfig.ServerConfig;
        const before = yield* fileSystem.readDirectory(config.attachmentsDir);
        const error = yield* service
          .persist({
            ...input,
            attachments: [{ ...input.attachments[0]!, ...patch }],
          })
          .pipe(Effect.flip);
        expect(error._tag).toBe("PersistChatAttachmentsError");
        expect(error.message).toBe(`Attachment capture.png ${message}`);
        expect(yield* fileSystem.readDirectory(config.attachmentsDir)).toEqual(before);
      }),
    );
  });

  it.effect("reports filesystem failures through the existing typed error", () =>
    Effect.gen(function* () {
      const service = yield* ChatAttachments.ChatAttachments;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const upload = { ...input, messageId: MessageId.make("write-failure-message") };
      const first = yield* service.persist(upload);
      const target = path.join(
        config.attachmentsDir,
        attachmentRelativePath(first.attachments[0]!)!,
      );
      yield* fileSystem.remove(target);
      yield* fileSystem.makeDirectory(target);
      const error = yield* service.persist(upload).pipe(Effect.flip);
      expect(error._tag).toBe("PersistChatAttachmentsError");
      expect(error.message).toBe("Could not persist attachment capture.png.");
      expect(error.cause).toBeDefined();
    }),
  );
});
