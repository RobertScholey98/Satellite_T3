import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { FactoryWorkflowVersion } from "@t3tools/contracts";

export const FactoryWorkflowSnapshot = Schema.Struct({
  version: FactoryWorkflowVersion,
  digest: Schema.String,
  snapshotPath: Schema.String,
  manifestPath: Schema.String,
});
export type FactoryWorkflowSnapshot = typeof FactoryWorkflowSnapshot.Type;

/**
 * Tag of the pinned runner image. Profiles store the image id it resolved to at qualification
 * and run that id, so rebuilding the tag never changes an existing profile's image.
 */
export const FACTORY_AGENT_IMAGE = "satellite-factory-agent:codex-0.161.0-claude-2.1.276";
/** Image label naming the provider drivers an image can run. Older profiles pin images without it. */
export const FACTORY_IMAGE_PROVIDERS_LABEL = "satellite.factory.providers";
// Built on demand by qualification, so installed servers need no source checkout.
// Bump FACTORY_AGENT_IMAGE whenever this changes. Claude Code is pinned to the Agent SDK's
// `claudeCodeVersion`. It refuses bypass permissions as root unless IS_SANDBOX is set, and
// discovery runs as root.
export const FACTORY_AGENT_DOCKERFILE = `FROM node:24.10.0-bookworm-slim@sha256:b8d2197aff9129d16c801a3e3e1b2a873c4946480f5a310f38056df2268c38d9

RUN apt-get update \\
    && apt-get install -y --no-install-recommends ca-certificates git ripgrep \\
    && rm -rf /var/lib/apt/lists/* \\
    && npm install --global @openai/codex@0.161.0 @anthropic-ai/claude-code@2.1.276 \\
    && npm cache clean --force

ENV HOME=/runtime \\
    CODEX_HOME=/runtime/codex \\
    CLAUDE_CONFIG_DIR=/runtime/claude \\
    IS_SANDBOX=1 \\
    DISABLE_AUTOUPDATER=1 \\
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1

LABEL ${FACTORY_IMAGE_PROVIDERS_LABEL}="codex claudeAgent"

WORKDIR /workspace
ENTRYPOINT ["codex", "app-server"]
`;

/**
 * Everything needed to start one confined runtime, stored as `profile.json` in its execution
 * directory. The optional blocks mark the runtime's role: `assignmentWorkspace` for an
 * assignment's writable volume, `inspection` for a read-only review snapshot, and `integration`
 * or `retro` for those runtimes. `boundaryId` names the execution directory that owns the
 * workspace's receipts and artifacts; a rebound profile keeps its original's.
 */
export const FactoryExecutionProfile = Schema.Struct({
  boundaryId: Schema.String,
  profileId: Schema.optionalKey(Schema.String),
  dockerContext: Schema.String,
  imageId: Schema.String,
  projectSnapshotPath: Schema.String,
  workflowSnapshotPath: Schema.String,
  workflow: Schema.optionalKey(FactoryWorkflowSnapshot),
  requiresSkillAuthoring: Schema.optionalKey(Schema.Boolean),
  runtimePath: Schema.String,
  sourceRevision: Schema.optionalKey(Schema.String),
  startingSourceId: Schema.optionalKey(Schema.String),
  startingSourceDigest: Schema.optionalKey(Schema.String),
  integration: Schema.optionalKey(
    Schema.Struct({
      integrationId: Schema.String,
      preparationId: Schema.String,
      inputDigest: Schema.String,
      grantIds: Schema.Array(Schema.String),
      manifestPath: Schema.String,
      stopPath: Schema.String,
    }),
  ),
  retro: Schema.optionalKey(
    Schema.Struct({
      retroId: Schema.String,
      assignmentId: Schema.String,
      conclusionId: Schema.String,
      evidenceDigest: Schema.String,
      sourceBasis: Schema.Literals(["final-candidate", "starting-snapshot", "integration-inputs"]),
      stopPath: Schema.String,
    }),
  ),
  inspection: Schema.optionalKey(
    Schema.Struct({
      sourceDigest: Schema.String,
      evidencePath: Schema.String,
      candidateId: Schema.optionalKey(Schema.String),
      deliveryHoldId: Schema.optionalKey(Schema.String),
    }),
  ),
  assignmentWorkspace: Schema.optionalKey(
    Schema.Struct({
      assignmentId: Schema.String,
      volumeName: Schema.String,
      grantEpoch: Schema.Number,
      boundaryId: Schema.String,
      controlsPath: Schema.String,
      // Its directory is the authority directory, which also holds the suspension, incident and
      // delivery-hold markers.
      revocationPath: Schema.String,
      workerUid: Schema.Number,
      workerGid: Schema.Number,
    }),
  ),
});
export type FactoryExecutionProfile = typeof FactoryExecutionProfile.Type;

/**
 * `suspension.json` in the authority directory. `generation` orders pauses, so a stale resume
 * cannot lift a newer pause.
 */
export const FactoryExecutionSuspension = Schema.Struct({
  generation: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  state: Schema.Literals(["suspended", "resumed"]),
});
export type FactoryExecutionSuspension = typeof FactoryExecutionSuspension.Type;
/**
 * `delivery-hold.json` in the authority directory. While `held`, the only runtime admitted for
 * the workspace is the read-only snapshot `profileId` names, prepared for the human's UI flow
 * review, and that snapshot runs only while the hold lasts.
 */
export const FactoryDeliveryExecutionHold = Schema.Struct({
  holdId: Schema.String,
  epoch: Schema.Int,
  state: Schema.Literals(["held", "released"]),
  profileId: Schema.String,
  sourceDigest: Schema.String,
});
export type FactoryDeliveryExecutionHold = typeof FactoryDeliveryExecutionHold.Type;

/** Provider homes under a runtime's `/runtime`, each with the workflow's skills mounted. */
const FACTORY_PROVIDER_HOMES = ["codex", "claude"] as const;
/** Model credentials a provider can keep in its home, relative to the runtime directory. */
export const FACTORY_PROVIDER_CREDENTIAL_FILES = ["codex/auth.json", "claude/.credentials.json"];

/**
 * Creates a runtime directory's provider homes before Docker mounts skills into them, so a
 * non-root `--user` worker never finds root-owned mountpoints. Returns their paths.
 */
export const makeFactoryProviderHomes = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  runtimePath: string,
) =>
  Effect.forEach(FACTORY_PROVIDER_HOMES, (home) => {
    const directory = path.join(runtimePath, home);
    return fs.makeDirectory(directory, { recursive: true }).pipe(Effect.as(directory));
  });

/**
 * The `docker run` arguments every confined runtime shares, up to but not including the image:
 * no capabilities, a read-only root, resource limits, and the mounts the profile's role needs.
 * An inspection always gets the read-only snapshot, never the assignment's volume. Callers
 * append their own `--name` or `--entrypoint`, then the image.
 */
export function factoryDockerArguments(profile: FactoryExecutionProfile): Array<string> {
  return [
    "--context",
    profile.dockerContext,
    "run",
    "--rm",
    "--interactive",
    "--pull",
    "never",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "256",
    "--memory",
    "2g",
    "--cpus",
    "2",
    "--add-host",
    "host.docker.internal:host-gateway",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=128m",
    "--mount",
    profile.assignmentWorkspace === undefined || profile.inspection !== undefined
      ? `type=bind,source=${profile.projectSnapshotPath},target=/workspace,readonly`
      : `type=volume,source=${profile.assignmentWorkspace.volumeName},target=/workspace,volume-nocopy`,
    "--mount",
    `type=bind,source=${profile.workflowSnapshotPath},target=/workflow,readonly`,
    "--mount",
    `type=bind,source=${profile.runtimePath},target=/runtime`,
    ...FACTORY_PROVIDER_HOMES.flatMap((home) => [
      "--mount",
      `type=bind,source=${profile.workflowSnapshotPath}/skills,target=/runtime/${home}/skills,readonly`,
    ]),
    ...(profile.integration === undefined
      ? []
      : ["--label", `satellite.factory.preparation=${profile.integration.preparationId}`]),
    ...(profile.inspection === undefined
      ? []
      : [
          "--mount",
          `type=bind,source=${profile.inspection.evidencePath},target=/evidence,readonly`,
        ]),
    ...(profile.assignmentWorkspace === undefined
      ? []
      : [
          "--user",
          `${profile.assignmentWorkspace.workerUid}:${profile.assignmentWorkspace.workerGid}`,
          "--mount",
          `type=bind,source=${profile.assignmentWorkspace.controlsPath},target=/controls,readonly`,
          "--label",
          `satellite.factory.assignment=${profile.assignmentWorkspace.assignmentId}`,
        ]),
  ];
}

/**
 * Whether a path may enter a managed snapshot. Any segment naming VCS metadata, an environment
 * file, a provider home or a credential refuses it, and source capture omits such files.
 */
export function admissibleFactorySourcePath(fileName: string): boolean {
  const parts = fileName.replaceAll("\\", "/").split("/");
  if (parts.some((part) => part === ".." || part === "." || part === "")) return false;
  return !parts.some(
    (part) =>
      /^(?:\.git|\.env(?:\..*)?|\.npmrc|\.yarnrc(?:\.yml)?|\.netrc|\.ssh|\.aws|\.azure|\.kube|\.codex|\.claude|secrets?|credentials?|auth\.json|id_rsa|id_ed25519)$/i.test(
        part,
      ) || /\.(?:pem|p12|pfx|key|keystore)$/i.test(part),
  );
}
