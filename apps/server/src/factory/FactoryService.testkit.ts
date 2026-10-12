import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSettings from "../serverSettings.ts";
import * as FactoryCollaborationEffects from "./FactoryCollaborationEffects.ts";
import * as FactoryDeliveryEffects from "./FactoryDeliveryEffects.ts";
import * as FactoryImprovementEffects from "./FactoryImprovementEffects.ts";
import * as FactoryIntegrationEffects from "./FactoryIntegrationEffects.ts";
import * as FactoryMergeEffects from "./FactoryMergeEffects.ts";
import * as FactoryMergeOperationEffects from "./FactoryMergeOperationEffects.ts";
import * as FactoryPreviewService from "./FactoryPreviewService.ts";
import * as FactoryRetroEffects from "./FactoryRetroEffects.ts";
import * as FactorySchedulingEffects from "./FactorySchedulingEffects.ts";
import * as FactoryWorkflowEffects from "./FactoryWorkflowEffects.ts";

const unused = Effect.die("This factory effect runtime is not part of the test.");
const leavePending = () => Effect.void;
const noContext = () => Effect.succeed({});

/**
 * What `FactoryService.layer` needs beyond the factory core, for tests: inert effect runtimes
 * (their intents stay pending and their commands get no extra context) and server settings with
 * the engineering managers beta on. Provide a test's real services first; this layer only fills
 * the ones still missing.
 */
export const layerTestDependencies = Layer.mergeAll(
  ServerSettings.layerTest({ engineeringManagersEnabled: true }).pipe(Layer.orDie),
  Layer.succeed(FactoryDeliveryEffects.FactoryDeliveryEffects, { handle: leavePending }),
  Layer.succeed(FactoryPreviewService.FactoryPreviewService, {
    reconcile: Effect.void,
    handle: leavePending,
    invoke: () => unused,
    finish: () => unused,
  }),
  Layer.succeed(FactoryRetroEffects.FactoryRetroEffects, {
    context: noContext,
    reconcile: Effect.void,
    handle: leavePending,
  }),
  Layer.succeed(FactorySchedulingEffects.FactorySchedulingEffects, {
    context: noContext,
    read: () => unused,
    reconcile: Effect.void,
    handle: leavePending,
    beforeLaunch: () => Effect.void,
    release: () => Effect.void,
    watch: () => Effect.void,
  }),
  Layer.succeed(FactoryImprovementEffects.FactoryImprovementEffects, {
    context: noContext,
    reconcile: Effect.void,
    handle: leavePending,
    watch: () => Effect.void,
  }),
  Layer.succeed(FactoryWorkflowEffects.FactoryWorkflowEffects, {
    context: noContext,
    handle: leavePending,
  }),
  Layer.succeed(FactoryCollaborationEffects.FactoryCollaborationEffects, {
    reconcile: Effect.void,
    handle: leavePending,
  }),
  Layer.succeed(FactoryIntegrationEffects.FactoryIntegrationEffects, { handle: leavePending }),
  Layer.succeed(FactoryMergeEffects.FactoryMergeEffects, { handle: leavePending }),
  Layer.succeed(FactoryMergeOperationEffects.FactoryMergeOperationEffects, {
    handle: leavePending,
  }),
);
