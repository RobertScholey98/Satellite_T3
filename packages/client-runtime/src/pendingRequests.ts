import {
  RuntimeRequestId,
  EventId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationThreadActivity,
  ProviderApprovalOption,
  ProviderRequestKind,
  UserInputQuestion,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import type { ThreadPendingApproval, ThreadPendingUserInput } from "./state/threadRequests.ts";

export type PendingApproval = ThreadPendingApproval;
export type PendingUserInput = ThreadPendingUserInput;

const isRequestId = Schema.is(RuntimeRequestId);
const isProviderRequestKind = Schema.is(ProviderRequestKind);
const isProviderApprovalOption = Schema.is(ProviderApprovalOption);
const QuestionOption = Schema.Struct({
  ...UserInputQuestion.fields.options.value.fields,
  label: Schema.String,
});
const isQuestionOption = Schema.is(QuestionOption);
// Native question IDs and option labels can be answer keys. Do not trim them.
const decodeQuestion = Schema.decodeUnknownOption(
  Schema.Struct({
    ...UserInputQuestion.fields,
    id: Schema.String,
    header: Schema.String,
    question: Schema.String,
    options: Schema.Array(QuestionOption),
    required: Schema.optional(Schema.Boolean),
  }),
);

/** Older activities use native request types instead of a request kind. */
export function requestKindFromRequestType(requestType: unknown): ProviderRequestKind | null {
  switch (requestType) {
    case "command_execution_approval":
    case "exec_command_approval":
    case "dynamic_tool_call":
      return "command";
    case "file_read_approval":
      return "file-read";
    case "file_change_approval":
    case "apply_patch_approval":
      return "file-change";
    case "mcp_elicitation_approval":
      return "mcp-elicitation";
    case "permission_approval":
      return "permission";
    default:
      return null;
  }
}

function parseQuestions(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((question) => {
    if (!Predicate.isObject(question) || !Array.isArray(question.options)) return [];
    const options = question.options.filter(isQuestionOption);
    if (options.length === 0 && question.allowCustomAnswer === false) return [];
    const parsed = decodeQuestion({
      id: question.id,
      header: question.header,
      question: question.question,
      options,
      multiSelect: question.multiSelect === true,
      ...(typeof question.required === "boolean" ? { required: question.required } : {}),
      ...(typeof question.allowCustomAnswer === "boolean"
        ? { allowCustomAnswer: question.allowCustomAnswer }
        : {}),
    });
    return Option.isSome(parsed) ? [parsed.value] : [];
  });
}

const requestActivityKinds = new Set([
  "approval.requested",
  "approval.resolved",
  "approval.cancelled",
  "provider.approval.respond.failed",
  "user-input.requested",
  "user-input.resolved",
  "user-input.cancelled",
  "provider.user-input.respond.failed",
]);

// The server reports a stale or unknown request through the failure text.
// A failed reply with any other text stays open so the user can retry.
const staleRequestFailureDetails = {
  "provider.approval.respond.failed": [
    "stale pending approval request",
    "unknown pending approval request",
    "unknown pending permission request",
    "unknown pending codex approval request",
  ],
  "provider.user-input.respond.failed": [
    "stale pending user-input request",
    "unknown pending user-input request",
    "unknown pending user input request",
    "unknown pending codex user input request",
  ],
} as const;

function isStaleRequestFailure(
  kind: keyof typeof staleRequestFailureDetails,
  payload: Record<string, unknown>,
): boolean {
  const detail = typeof payload.detail === "string" ? payload.detail.toLowerCase() : "";
  return staleRequestFailureDetails[kind].some((fragment) => detail.includes(fragment));
}

/** Reduces request state once for web, desktop, and mobile. Layout stays with each client. */
export function derivePendingRequests(activities: ReadonlyArray<OrchestrationThreadActivity>) {
  const approvals = new Map<RuntimeRequestId, PendingApproval>();
  const userInputs = new Map<RuntimeRequestId, PendingUserInput>();
  const closedApprovals = new Set<RuntimeRequestId>();
  const closedUserInputs = new Set<RuntimeRequestId>();

  // Request IDs are unique. A terminal event stays final even when provider
  // sequences and server-generated activities arrive in a different order.
  for (const activity of activities) {
    if (!requestActivityKinds.has(activity.kind)) continue;
    const payload = Predicate.isObject(activity.payload) ? activity.payload : undefined;
    if (!payload || !isRequestId(payload.requestId)) continue;
    const requestId = payload.requestId;

    if (activity.kind === "approval.requested") {
      if (
        closedApprovals.has(requestId) ||
        payload.requestType === "tool_user_input" ||
        payload.requestType === "auth_tokens_refresh"
      ) {
        continue;
      }
      const requestKind = isProviderRequestKind(payload.requestKind)
        ? payload.requestKind
        : requestKindFromRequestType(payload.requestType);
      const options = Array.isArray(payload.options)
        ? payload.options.filter(isProviderApprovalOption)
        : [];
      approvals.set(requestId, {
        requestId,
        // Older OpenCode approvals do not always include a recognized kind.
        requestKind: requestKind ?? "command",
        createdAt: activity.createdAt,
        responseCapability:
          payload.responseCapability === "not_resumable" ? "not_resumable" : "live",
        ...(typeof payload.detail === "string" && payload.detail ? { detail: payload.detail } : {}),
        ...(typeof payload.appName === "string" && payload.appName
          ? { appName: payload.appName }
          : {}),
        ...(options.length > 0 ? { options } : {}),
      });
    } else if (activity.kind === "user-input.requested") {
      if (closedUserInputs.has(requestId)) continue;
      const questions = parseQuestions(payload.questions);
      if (questions.length === 0) continue;
      userInputs.set(requestId, {
        requestId,
        createdAt: activity.createdAt,
        questions: questions.map((question) => ({
          ...question,
          multiSelect: question.multiSelect ?? false,
        })),
        responseCapability:
          payload.responseCapability === "not_resumable"
            ? "not_resumable"
            : payload.responseMode === "message"
              ? "message"
              : "live",
        ...(payload.responseMode === "message" ? { responseMode: "message" as const } : {}),
        dismissible: payload.responseMode === "message",
      });
    } else if (
      activity.kind === "approval.resolved" ||
      activity.kind === "approval.cancelled" ||
      (activity.kind === "provider.approval.respond.failed" &&
        isStaleRequestFailure(activity.kind, payload))
    ) {
      closedApprovals.add(requestId);
      approvals.delete(requestId);
    } else if (
      activity.kind === "user-input.resolved" ||
      activity.kind === "user-input.cancelled" ||
      (activity.kind === "provider.user-input.respond.failed" &&
        isStaleRequestFailure(activity.kind, payload))
    ) {
      closedUserInputs.add(requestId);
      userInputs.delete(requestId);
    }
  }

  const byCreatedAt = (
    left: { readonly createdAt: string },
    right: { readonly createdAt: string },
  ) => left.createdAt.localeCompare(right.createdAt);
  return {
    approvals: [...approvals.values()].sort(byCreatedAt),
    userInputs: [...userInputs.values()].sort(byCreatedAt),
  };
}

/** Projects request evidence for Satellite's delivery reconciliation and pill editor. */
export function threadRequestActivities(
  projection: Pick<OrchestrationV2ThreadProjection, "runtimeRequests" | "turnItems">,
): OrchestrationThreadActivity[] {
  return projection.runtimeRequests.flatMap((request) => {
    if (request.kind === "auth_refresh" || request.kind === "dynamic_tool_call") return [];
    const isQuestion = request.kind === "user_input";
    const item = projection.turnItems.findLast(
      (item) =>
        (item.type === "user_input_request" || item.type === "approval_request") &&
        item.requestId === request.id,
    );
    const kind = isQuestion ? "user-input" : "approval";
    const created: OrchestrationThreadActivity = {
      id: EventId.make(`${request.id}:requested`),
      kind: `${kind}.requested`,
      tone: "approval",
      summary: isQuestion ? "Question" : "Approval required",
      turnId: null,
      createdAt: DateTime.formatIso(request.createdAt),
      payload: {
        requestId: request.id,
        requestKind: request.kind,
        responseCapability: request.responseCapability.type,
        ...(item?.type === "user_input_request"
          ? {
              questions: item.questions,
              ...(item.responseMode === "message" || request.responseCapability.type === "message"
                ? { responseMode: "message" }
                : {}),
            }
          : {}),
        ...(item?.type === "approval_request"
          ? {
              detail: item.prompt,
              appName: item.appName,
              options: item.options,
            }
          : {}),
      },
    };
    return request.status === "pending"
      ? [created]
      : [
          created,
          {
            ...created,
            id: EventId.make(`${request.id}:${request.status}`),
            kind: `${kind}.resolved`,
            createdAt: DateTime.formatIso(request.resolvedAt ?? request.createdAt),
          },
        ];
  });
}
