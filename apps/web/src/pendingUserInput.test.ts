import { describe, expect, it } from "vite-plus/test";

import {
  buildPendingUserInputAnswers,
  togglePendingUserInputOptionSelection,
} from "@t3tools/client-runtime/work-log/user-input";
import {
  carryDisplacedCustomAnswerIntoPrompt,
  countAnsweredPendingUserInputQuestions,
  derivePendingUserInputProgress,
  findFirstUnansweredPendingUserInputQuestionIndex,
} from "./pendingUserInput";

const singleSelectQuestion = {
  id: "scope",
  header: "Scope",
  question: "What should the plan target first?",
  options: [
    {
      label: "Orchestration-first",
      description: "Focus on orchestration first",
    },
  ],
  multiSelect: false,
} as const;

const multiSelectQuestion = {
  id: "areas",
  header: "Areas",
  question: "Which areas should this change cover?",
  options: [
    {
      label: "Server",
      description: "Server",
    },
    {
      label: "Web",
      description: "Web",
    },
  ],
  multiSelect: true,
} as const;

const nativeChoiceQuestion = {
  id: "result",
  header: "Result",
  question: "Which result should be used?",
  options: [
    { value: " first\t", label: "Result", description: "First result" },
    { value: "second", label: "Result", description: "Second result" },
  ],
  allowCustomAnswer: false,
  multiSelect: false,
} as const;

describe("selected option values", () => {
  it.each([" first\t", ""])("preserves the exact selected option value %j", (value) => {
    const question = {
      ...nativeChoiceQuestion,
      options: [{ ...nativeChoiceQuestion.options[0], value }, nativeChoiceQuestion.options[1]],
    };
    const draft = togglePendingUserInputOptionSelection(question, undefined, value);

    expect(buildPendingUserInputAnswers([question], { result: draft })).toEqual({ result: value });
    expect(derivePendingUserInputProgress([question], { result: draft }, 0)).toMatchObject({
      selectedOptionValues: [value],
      answeredQuestionCount: 1,
      canAdvance: true,
      isComplete: true,
    });
  });
});

describe("pending user input question progress", () => {
  it("counts a deliberately cleared editor answer as answered", () => {
    const question = { ...singleSelectQuestion, initialAnswer: "  Proposed message\n" };
    const questions = [question, { ...singleSelectQuestion, id: "follow-up" }];
    const drafts = { scope: { customAnswer: "" } };
    expect(findFirstUnansweredPendingUserInputQuestionIndex(questions, drafts)).toBe(1);
    expect(derivePendingUserInputProgress([question], drafts, 0)).toMatchObject({
      customAnswer: "",
      resolvedAnswer: "",
      usingCustomAnswer: false,
      canAdvance: true,
      isComplete: true,
    });
    expect(
      derivePendingUserInputProgress([question], { scope: { customAnswer: " \n" } }, 0),
    ).toMatchObject({ resolvedAnswer: " \n", usingCustomAnswer: true });
  });

  const questions = [
    singleSelectQuestion,
    {
      id: "compat",
      header: "Compat",
      question: "How strict should compatibility be?",
      options: [
        {
          label: "Keep current envelope",
          description: "Preserve current wire format",
        },
      ],
      multiSelect: false,
    },
  ] as const;

  it("counts only answered questions", () => {
    expect(
      countAnsweredPendingUserInputQuestions(questions, {
        scope: {
          selectedOptionValues: ["Orchestration-first"],
        },
      }),
    ).toBe(1);
  });

  it("finds the first unanswered question", () => {
    expect(
      findFirstUnansweredPendingUserInputQuestionIndex(questions, {
        scope: {
          selectedOptionValues: ["Orchestration-first"],
        },
      }),
    ).toBe(1);
  });

  it("returns the last question index when all answers are complete", () => {
    expect(
      findFirstUnansweredPendingUserInputQuestionIndex(questions, {
        scope: {
          selectedOptionValues: ["Orchestration-first"],
        },
        compat: {
          customAnswer: "Keep it for one release window",
        },
      }),
    ).toBe(1);
  });

  it("derives the active question and advancement state", () => {
    expect(
      derivePendingUserInputProgress(
        questions,
        {
          scope: {
            selectedOptionValues: ["Orchestration-first"],
          },
        },
        0,
      ),
    ).toMatchObject({
      questionIndex: 0,
      activeQuestion: questions[0],
      selectedOptionValues: ["Orchestration-first"],
      customAnswer: "",
      resolvedAnswer: "Orchestration-first",
      answeredQuestionCount: 1,
      isLastQuestion: false,
      isComplete: false,
      canAdvance: true,
    });
  });

  it("treats multi-select questions as answered when they have selected options", () => {
    expect(
      derivePendingUserInputProgress(
        [multiSelectQuestion],
        {
          areas: {
            selectedOptionValues: ["Server", "Web"],
          },
        },
        0,
      ),
    ).toMatchObject({
      selectedOptionValues: ["Server", "Web"],
      resolvedAnswer: ["Server", "Web"],
      canAdvance: true,
      isComplete: true,
    });
  });

  it("requires an option when custom answers are disabled", () => {
    const drafts = { result: { customAnswer: "Use another result" } };

    expect(buildPendingUserInputAnswers([nativeChoiceQuestion], drafts)).toBeNull();
    expect(derivePendingUserInputProgress([nativeChoiceQuestion], drafts, 0)).toMatchObject({
      customAnswer: "",
      usingCustomAnswer: false,
      resolvedAnswer: null,
      answeredQuestionCount: 0,
      canAdvance: false,
      isComplete: false,
    });
  });
});

it("accepts attachment-only answers after every upload finishes", () => {
  const questions = [
    { id: "spec", header: "Spec", question: "Provide a spec", options: [], multiSelect: false },
  ];
  expect(buildPendingUserInputAnswers(questions, { spec: { attachmentCount: 1 } })).toEqual({
    spec: "",
  });
  expect(
    buildPendingUserInputAnswers(questions, {
      spec: { attachmentCount: 1, attachmentsBlocked: true },
    }),
  ).toBeNull();
  expect(
    buildPendingUserInputAnswers([{ ...questions[0]!, allowCustomAnswer: false }], {
      spec: { attachmentCount: 1 },
    }),
  ).toBeNull();
});

describe("carryDisplacedCustomAnswerIntoPrompt", () => {
  it("keeps the thread draft when nothing was typed into the answer", () => {
    expect(carryDisplacedCustomAnswerIntoPrompt("draft", undefined)).toBe("draft");
    expect(carryDisplacedCustomAnswerIntoPrompt("draft", "   ")).toBe("draft");
  });

  it("moves the typed answer into an empty thread draft", () => {
    expect(carryDisplacedCustomAnswerIntoPrompt("", "also rename the flag ")).toBe(
      "also rename the flag",
    );
  });

  it("appends the typed answer after an existing thread draft", () => {
    expect(carryDisplacedCustomAnswerIntoPrompt("first half\n", "second half")).toBe(
      "first half\n\nsecond half",
    );
  });
});
