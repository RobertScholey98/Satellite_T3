import { CommandId, FactoryBoundaryId, ProjectId, type FactorySnapshot } from "@t3tools/contracts";

export function sharedAccessFixture(state: FactorySnapshot, experiment = false): FactorySnapshot {
  const assignment = state.assignments[0]!;
  const manager = state.managers.find((entry) => entry.id === assignment.managerId)!;
  const now = assignment.createdAt;
  const repositoryId = "shared-repository";
  const boundaryId =
    assignment.grant?.boundaryId ??
    state.boundaries[0]?.id ??
    FactoryBoundaryId.make("shared-boundary");
  return {
    ...state,
    managers: state.managers.map((entry) =>
      entry.id !== manager.id
        ? entry
        : {
            ...entry,
            role: "system",
            projectId: null,
            workspaceProjectId: ProjectId.make("system-reference"),
            qualification: { status: "qualified", profileId: "system-profile", checkedAt: now },
          },
    ),
    assignments: state.assignments.map((entry) =>
      entry.id !== assignment.id
        ? entry
        : {
            ...entry,
            kind: "implementation",
            sharedWork: experiment
              ? { kind: "experiment", repositoryId, experimentId: "experiment" }
              : { kind: "implementation", repositoryId, workId: "shared-work" },
          },
    ),
    sharedRepositories: [
      {
        id: repositoryId,
        managerId: manager.id,
        projectId: assignment.projectId,
        kind: "skills",
        repositoryRoot: "/owned-skills",
        boundaryId,
        enabled: true,
        registeredAt: now,
      },
    ],
    sharedWorks: experiment
      ? []
      : [
          {
            id: "shared-work",
            notification: null,
            managerId: manager.id,
            createdAt: now,
            plan: {
              proposalId: "proposal",
              proposalRevision: "revision",
              repositoryId,
              work: {
                title: "Update shared instructions",
                scope: {
                  description: "Approved instruction change",
                  completionCondition: "Merged",
                  requiresPullRequest: true,
                },
                complexity: "standard",
                kind: "rule-change",
                sourcePaths: [],
                creatableDirectories: [],
                controlPaths: ["SKILL.md"],
              },
              expectedBenefit: "Consistent implementation",
              assessmentApproach: "Later retrospective evidence",
              changesSkills: true,
              weakensRules: false,
            },
            lifecycle: {
              phase: "commissioned",
              commandId: CommandId.make("shared-authorization"),
              authorizedAt: now,
              assignmentId: assignment.id,
            },
          },
        ],
    experimentConfigurations: [
      {
        enabled: experiment,
        maxConcurrent: 1,
        maxPerInvestigation: 1,
        configuredAt: now,
        commandId: CommandId.make("experiment-config"),
      },
    ],
    workflowExperiments: experiment
      ? [
          {
            id: "experiment",
            managerId: manager.id,
            repositoryId,
            investigationId: "investigation",
            assignmentId: assignment.id,
            expectedBenefit: "Candidate comparison",
            assessmentApproach: "Isolated inspection",
            createdAt: now,
          },
        ]
      : [],
  };
}
