import * as Schema from "effect/Schema";

export const FACTORY_CODEX_IMAGE = "satellite-factory-codex:0.161.0";
export const FACTORY_CONTAINER_WORKSPACE = "/workspace";

export const FactoryExecutionProfile = Schema.Struct({
  boundaryId: Schema.String,
  profileId: Schema.optionalKey(Schema.String),
  dockerContext: Schema.String,
  imageId: Schema.String,
  projectSnapshotPath: Schema.String,
  workflowSnapshotPath: Schema.String,
  runtimePath: Schema.String,
  sourceRevision: Schema.optionalKey(Schema.String),
  startingSourceId: Schema.optionalKey(Schema.String),
  startingSourceDigest: Schema.optionalKey(Schema.String),
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
      revocationPath: Schema.String,
      workerUid: Schema.Number,
      workerGid: Schema.Number,
    }),
  ),
});
export type FactoryExecutionProfile = typeof FactoryExecutionProfile.Type;

export const FactoryExecutionSuspension = Schema.Struct({
  generation: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  state: Schema.Literals(["suspended", "resumed"]),
});
export type FactoryExecutionSuspension = typeof FactoryExecutionSuspension.Type;
export const FactoryDeliveryExecutionHold = Schema.Struct({
  holdId: Schema.String,
  epoch: Schema.Int,
  state: Schema.Literals(["held", "released"]),
  profileId: Schema.String,
  sourceDigest: Schema.String,
});
export type FactoryDeliveryExecutionHold = typeof FactoryDeliveryExecutionHold.Type;

export function factoryContainerEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    url.hostname = "host.docker.internal";
  }
  return url.toString();
}

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
    "--mount",
    `type=bind,source=${profile.workflowSnapshotPath}/skills,target=/runtime/codex/skills,readonly`,
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
