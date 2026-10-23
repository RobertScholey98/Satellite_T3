import type {
  FactoryControlPath,
  FactoryOnboardingProposal,
  FactoryOnboardingResult,
  FactoryPickupColumn,
} from "@t3tools/contracts";

/**
 * Factory tools are not in the shared T3 tool registry, so the harness prefix is matched here:
 * `mcp__t3-code__…` (Claude), `t3-code.…` (Codex), `t3-code-<thread>_…` (OpenCode) or bare.
 */
const PROPOSE_ONBOARDING_TOOL = /(?:^|[_.:/\s])factory_propose_onboarding$/i;

export function isFactoryOnboardingProposalTool(toolName: string | null | undefined): boolean {
  return toolName != null && PROPOSE_ONBOARDING_TOOL.test(toolName.trim());
}

export const OTHER_ANSWER = "other";

interface OnboardingAnswer {
  /** An index into the question's options, or `OTHER_ANSWER`. */
  readonly choice: number | typeof OTHER_ANSWER;
  readonly other: string;
}

interface OnboardingControlPathChoice extends FactoryControlPath {
  readonly kept: boolean;
}

export interface OnboardingForm {
  readonly purpose: string;
  readonly pickupEnabled: boolean;
  readonly columns: ReadonlyArray<FactoryPickupColumn>;
  readonly guidance: string;
  readonly answers: Readonly<Record<string, OnboardingAnswer>>;
  readonly controlPaths: ReadonlyArray<OnboardingControlPathChoice>;
}

/** Pickup starts off with no column ticked, whatever the manager proposed: the user maps Ready. */
export function initialOnboardingForm(proposal: FactoryOnboardingProposal): OnboardingForm {
  return {
    purpose: proposal.purpose,
    pickupEnabled: false,
    columns: [],
    guidance: proposal.pickup.guidance,
    answers: Object.fromEntries(
      proposal.rules.map((rule) => [
        rule.id,
        {
          choice: rule.recommended < rule.options.length ? rule.recommended : OTHER_ANSWER,
          other: "",
        },
      ]),
    ),
    controlPaths: proposal.controlPaths.map((entry) => ({ ...entry, kept: true })),
  };
}

export function sameColumn(a: FactoryPickupColumn, b: FactoryPickupColumn): boolean {
  return a.boardId === b.boardId && a.columnId === b.columnId;
}

export function toggleColumn(
  form: OnboardingForm,
  column: FactoryPickupColumn,
  ticked: boolean,
): OnboardingForm {
  const rest = form.columns.filter((entry) => !sameColumn(entry, column));
  return { ...form, columns: ticked ? [...rest, column] : rest };
}

function answerText(
  options: ReadonlyArray<string>,
  answer: OnboardingAnswer | undefined,
): string | null {
  if (answer === undefined) return null;
  const text = answer.choice === OTHER_ANSWER ? answer.other.trim() : options[answer.choice];
  return text === undefined || text === "" ? null : text;
}

/** Why Approve is unavailable, or null when the form is complete. */
export function onboardingApproveBlocker(
  proposal: FactoryOnboardingProposal,
  form: OnboardingForm,
): string | null {
  if (proposal.rules.some((rule) => answerText(rule.options, form.answers[rule.id]) === null)) {
    return "Answer every question to approve.";
  }
  if (form.pickupEnabled && form.columns.length === 0) {
    return "Tick at least one Ready column, or turn pickup off.";
  }
  return null;
}

export function onboardingResultFromForm(
  proposal: FactoryOnboardingProposal,
  form: OnboardingForm,
  concurrencyCap: number,
): FactoryOnboardingResult {
  return {
    purpose: form.purpose.trim(),
    pickup: {
      enabled: form.pickupEnabled,
      columns: form.pickupEnabled ? form.columns : [],
      labels: [],
      guidance: form.guidance.trim(),
    },
    baseBranch: null,
    rules: proposal.rules.map((rule) => ({
      id: rule.id,
      question: rule.question,
      answer: answerText(rule.options, form.answers[rule.id]) ?? "",
    })),
    controlPaths: form.controlPaths
      .filter((entry) => entry.kept)
      .map(({ path, reason }) => ({ path, reason })),
    teamIds: [],
    concurrencyCap,
  };
}
