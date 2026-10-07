import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import {
  IdeaArtifact,
  IdeaArtifactId,
  IdeaIssueDraft,
  IdeaPromotion,
  McpCapabilityUnavailableError,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";
import { IdeaRuntime, IdeaRuntimeError } from "../../../ideas/IdeaRuntime.ts";
import { IdeaPromotion as PromotionService } from "../../../ideas/IdeaPromotion.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";

const dependencies = [ThreadManagementService, McpInvocationContext, IdeaRuntime, PromotionService];
const failure = Schema.Union([
  IdeaRuntimeError,
  McpCapabilityUnavailableError,
  OrchestratorMcpFailure,
]);
export const IdeaImageTool = Tool.make("idea_read_image", {
  description:
    "View an image attached to this idea. Pass its artifact ID from the notebook. Returns PNG, JPEG, GIF or WebP pixels to inspect.",
  parameters: Schema.Struct({ artifactId: IdeaArtifactId }),
  success: Schema.Struct({
    artifact: IdeaArtifact,
    screenshot: Schema.Struct({
      data: Schema.String,
      mimeType: Schema.String,
      width: Schema.Number,
      height: Schema.Number,
    }),
  }),
  failure,
  dependencies: [ThreadManagementService, McpInvocationContext, IdeaRuntime],
}).annotate(Tool.Readonly, true);
export const IdeasImageToolkit = Toolkit.make(IdeaImageTool);
export const IdeasToolkit = Toolkit.make(
  Tool.make("idea_read", {
    description:
      "Read this idea's notebook, linked entry, discussion history, text document, or promotion instructions. For /promote first read resource=promote. resource=skill accepts only to-issues, to-prd or to-spec.",
    parameters: Schema.Struct({
      resource: Schema.Literals(["notebook", "entry", "history", "artifact", "promote", "skill"]),
      id: Schema.optional(Schema.String),
      offset: Schema.optional(Schema.Int),
    }),
    success: Schema.String,
    failure,
    dependencies,
  }).annotate(Tool.Readonly, true),
  Tool.make("idea_read_main", {
    description:
      "Read the current turn's main revision without accessing the working checkout. Omit arguments to list files, pass path to read a regular file, or query for a literal text search.",
    parameters: Schema.Struct({
      path: Schema.optional(Schema.String),
      query: Schema.optional(Schema.String),
    }),
    success: Schema.Struct({ revision: Schema.String, text: Schema.String }),
    failure,
    dependencies,
  }).annotate(Tool.Readonly, true),
  Tool.make("idea_write_document", {
    description:
      "Save a generated text document inside this idea. The name is a label, not a filesystem path. Use text/html for an interactive design or text/markdown for a PRD or spec.",
    parameters: Schema.Struct({
      name: Schema.String,
      mediaType: Schema.String,
      text: Schema.String.check(Schema.isMaxLength(500_000)),
    }),
    success: IdeaArtifact,
    failure,
    dependencies,
  }),
  Tool.make("idea_propose_issues", {
    description:
      "Save a self-contained issue breakdown for the user's review. Include implementation context in each body. Tickets must not rely on this idea's local links or documents. Record any scope still unaddressed.",
    parameters: Schema.Struct({
      drafts: Schema.Array(IdeaIssueDraft),
      remainingScope: Schema.String,
    }),
    success: IdeaPromotion,
    failure,
    dependencies,
  }),
  Tool.make("idea_publish_issues", {
    description:
      "Publish the breakdown only after the user has approved it in T3. Retries reconcile previous attempts before creating missing issues.",
    success: IdeaPromotion,
    failure,
    dependencies,
  }).annotate(Tool.OpenWorld, true),
);
