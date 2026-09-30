import type {
  IdeaSource,
  OrchestrationThread,
  OrchestrationThreadActivity,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";

const decodeQuestion = Schema.decodeUnknownOption(
  Schema.Struct({
    requestId: Schema.optional(Schema.String),
    questions: Schema.optional(Schema.Unknown),
    answers: Schema.optional(Schema.Unknown),
    questionTextById: Schema.optional(Schema.Unknown),
    attachmentsByQuestionId: Schema.optional(Schema.Unknown),
  }),
);
const encodeQuestion = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export function ideaActivityDiscussion(activities: readonly OrchestrationThreadActivity[]) {
  const questions = new Map<string, unknown>();
  const discussion: Array<{
    id: string;
    source: IdeaSource;
    role: string;
    text: string;
    sequence: number;
    createdAt: string;
  }> = [];
  for (const activity of activities) {
    if (
      !["user-input.requested", "user-input.resolved", "user-input.answer-submitted"].includes(
        activity.kind,
      )
    )
      continue;
    const decoded = decodeQuestion(activity.payload);
    if (Option.isNone(decoded)) continue;
    const payload = decoded.value;
    if (activity.kind === "user-input.requested" && payload.requestId)
      questions.set(payload.requestId, payload.questions);
    if (activity.kind !== "user-input.requested" && payload.answers === undefined) continue;
    const text = encodeQuestion({
      questions:
        payload.questions ??
        payload.questionTextById ??
        (payload.requestId ? questions.get(payload.requestId) : undefined),
      ...(payload.answers === undefined ? {} : { answers: payload.answers }),
      ...(payload.attachmentsByQuestionId === undefined
        ? {}
        : { attachmentsByQuestionId: payload.attachmentsByQuestionId }),
    });
    discussion.push({
      id: activity.id,
      source: { kind: "activity", activityId: activity.id },
      role: activity.kind === "user-input.requested" ? "assistant" : "user",
      text,
      sequence: activity.sequence ?? 0,
      createdAt: activity.createdAt,
    });
  }
  return discussion;
}

export function ideaSourceKey(source: IdeaSource): string {
  const id =
    source.kind === "message"
      ? source.messageId
      : source.kind === "activity"
        ? source.activityId
        : source.artifactId;
  return source.kind + ":" + id;
}

export function ideaThreadDiscussion(thread: Pick<OrchestrationThread, "messages" | "activities">) {
  return [
    ...thread.messages.map((message) => ({
      id: message.id,
      source: { kind: "message" as const, messageId: message.id },
      role: message.role,
      text: message.text,
      createdAt: message.createdAt,
    })),
    ...ideaActivityDiscussion(thread.activities),
  ].toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
}
