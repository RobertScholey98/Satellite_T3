import { describe, expect, it } from "vite-plus/test";
import { ApprovalRequestId, type UserInputAttachmentAnswerPayload } from "@t3tools/contracts";
import {
  buildPendingUserInputAnswers,
  getQuestionTextPreview,
  isPendingUserInputOptionSelected,
  resolvePendingUserInputAnswer,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
} from "./userInput.ts";

function answer(
  overrides: Partial<UserInputAttachmentAnswerPayload> = {},
): UserInputAttachmentAnswerPayload {
  return {
    requestId: ApprovalRequestId.make("request-1"),
    questionTextById: { scope: "Which repository?" },
    answers: { scope: "Use the private repository" },
    attachmentsByQuestionId: {},
    ...overrides,
  };
}

describe("getQuestionTextPreview", () => {
  it("joins the question texts", () => {
    expect(
      getQuestionTextPreview(
        answer({ questionTextById: { scope: "Which repository?", name: "What name?" } }),
      ),
    ).toBe("Which repository? · What name?");
  });

  it("normalizes whitespace and skips blank texts", () => {
    expect(
      getQuestionTextPreview(
        answer({ questionTextById: { scope: "Which\nrepository?", x: "  " } }),
      ),
    ).toBe("Which repository?");
  });

  it("returns an empty string without question texts", () => {
    expect(getQuestionTextPreview(answer({ questionTextById: undefined }))).toBe("");
  });
});

const singleSelectQuestion = {
  id: "scope",
  header: "Scope",
  question: "What should the plan target first?",
  options: [
    { label: "Orchestration-first", description: "Focus on orchestration first" },
    { label: "UI-first", description: "Focus on the UI first" },
  ],
  multiSelect: false,
} as const;

const multiSelectQuestion = {
  id: "areas",
  header: "Areas",
  question: "Which areas should this change cover?",
  options: [
    { label: "Server", description: "Server" },
    { label: "Web", description: "Web" },
  ],
  multiSelect: true,
} as const;

const offeredValuesOnlyQuestion = {
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

describe("resolvePendingUserInputAnswer", () => {
  it("prefers a custom answer over selected options", () => {
    expect(
      resolvePendingUserInputAnswer(singleSelectQuestion, {
        selectedOptionValues: ["Orchestration-first"],
        customAnswer: "Keep the existing envelope for one release",
      }),
    ).toBe("Keep the existing envelope for one release");
  });

  it("answers with the selected option, or every selected option for multi-select", () => {
    expect(
      resolvePendingUserInputAnswer(singleSelectQuestion, {
        selectedOptionValues: ["Orchestration-first"],
      }),
    ).toBe("Orchestration-first");
    expect(
      resolvePendingUserInputAnswer(multiSelectQuestion, {
        selectedOptionValues: ["Server", "Web"],
      }),
    ).toEqual(["Server", "Web"]);
  });

  it("does not replace a required choice with a custom answer", () => {
    expect(
      resolvePendingUserInputAnswer(offeredValuesOnlyQuestion, {
        selectedOptionValues: ["second"],
        customAnswer: "Use another result",
      }),
    ).toBe("second");
  });

  it("does not submit labels or unknown values when an option has a value", () => {
    expect(
      resolvePendingUserInputAnswer(offeredValuesOnlyQuestion, {
        selectedOptionValues: ["Result", "unknown"],
      }),
    ).toBeNull();
    expect(
      resolvePendingUserInputAnswer(offeredValuesOnlyQuestion, {
        selectedOptionValues: ["second"],
      }),
    ).toBe("second");
  });

  it("preserves exact editor text, including a deliberately cleared answer", () => {
    const question = { ...singleSelectQuestion, initialAnswer: "  Proposed message\n" };
    expect(resolvePendingUserInputAnswer(question, { customAnswer: question.initialAnswer })).toBe(
      "  Proposed message\n",
    );
    expect(resolvePendingUserInputAnswer(question, { customAnswer: "  Edited message\n\n" })).toBe(
      "  Edited message\n\n",
    );
    expect(resolvePendingUserInputAnswer(question, { customAnswer: "" })).toBe("");
    expect(resolvePendingUserInputAnswer(question, { customAnswer: " \n" })).toBe(" \n");
    expect(resolvePendingUserInputAnswer(singleSelectQuestion, { customAnswer: " \n" })).toBeNull();
  });

  it("accepts ready attachment-only answers while preserving selected options", () => {
    const question = {
      id: "q",
      header: "Spec",
      question: "Provide a specification",
      options: [{ label: "Yes", description: "Approve" }],
      multiSelect: false,
    };
    expect(resolvePendingUserInputAnswer(question, { attachmentCount: 1 })).toBe("");
    expect(
      resolvePendingUserInputAnswer(question, {
        attachmentCount: 1,
        selectedOptionValues: ["Yes"],
      }),
    ).toBe("Yes");
    expect(
      resolvePendingUserInputAnswer(question, { attachmentCount: 1, attachmentsBlocked: true }),
    ).toBeNull();
    expect(
      resolvePendingUserInputAnswer(
        { ...question, allowCustomAnswer: false },
        { attachmentCount: 1 },
      ),
    ).toBeNull();
  });
});

describe("setPendingUserInputCustomAnswer", () => {
  it("clears the selected options once the custom answer has text", () => {
    expect(
      setPendingUserInputCustomAnswer(
        multiSelectQuestion,
        { selectedOptionValues: ["Server", "Web"] },
        "Server first",
      ),
    ).toEqual({ customAnswer: "Server first" });
    expect(
      setPendingUserInputCustomAnswer(
        multiSelectQuestion,
        { selectedOptionValues: ["Server"] },
        " ",
      ),
    ).toEqual({ customAnswer: " ", selectedOptionValues: ["Server"] });
  });

  it("ignores typing when the question only accepts offered options", () => {
    const draft = { selectedOptionValues: ["second"] };
    expect(setPendingUserInputCustomAnswer(offeredValuesOnlyQuestion, draft, "Other")).toBe(draft);
    expect(setPendingUserInputCustomAnswer(offeredValuesOnlyQuestion, undefined, "Other")).toEqual(
      {},
    );
  });

  it("drops selected options for an editor question even when its text is cleared", () => {
    const question = { ...singleSelectQuestion, initialAnswer: "  Proposed message\n" };
    expect(
      setPendingUserInputCustomAnswer(question, { selectedOptionValues: ["UI-first"] }, ""),
    ).toEqual({ customAnswer: "" });
  });
});

describe("togglePendingUserInputOptionSelection", () => {
  it("replaces the single-select option and toggles multi-select options", () => {
    expect(
      togglePendingUserInputOptionSelection(
        singleSelectQuestion,
        { selectedOptionValues: ["Orchestration-first"] },
        "UI-first",
      ),
    ).toEqual({ customAnswer: "", selectedOptionValues: ["UI-first"] });

    const server = togglePendingUserInputOptionSelection(multiSelectQuestion, undefined, "Server");
    const serverAndWeb = togglePendingUserInputOptionSelection(multiSelectQuestion, server, "Web");
    expect(serverAndWeb).toEqual({ customAnswer: "", selectedOptionValues: ["Server", "Web"] });
    expect(
      togglePendingUserInputOptionSelection(multiSelectQuestion, serverAndWeb, "Server"),
    ).toEqual({ customAnswer: "", selectedOptionValues: ["Web"] });
  });

  it("matches a padded label to its option", () => {
    const padded = togglePendingUserInputOptionSelection(multiSelectQuestion, undefined, "  Web  ");
    expect(padded).toEqual({ customAnswer: "", selectedOptionValues: ["Web"] });
    expect(togglePendingUserInputOptionSelection(multiSelectQuestion, padded, "  Web  ")).toEqual({
      customAnswer: "",
    });
  });

  it("ignores an option the question no longer offers", () => {
    const draft = { selectedOptionValues: ["Server"] };
    expect(togglePendingUserInputOptionSelection(multiSelectQuestion, draft, "Mobile")).toBe(draft);
    expect(togglePendingUserInputOptionSelection(offeredValuesOnlyQuestion, draft, "Result")).toBe(
      draft,
    );
  });

  it("selects and removes options with the same label independently", () => {
    const question = { ...offeredValuesOnlyQuestion, multiSelect: true };
    const first = togglePendingUserInputOptionSelection(question, undefined, " first\t");
    const both = togglePendingUserInputOptionSelection(question, first, "second");
    expect(buildPendingUserInputAnswers([question], { result: both })).toEqual({
      result: [" first\t", "second"],
    });

    const secondOnly = togglePendingUserInputOptionSelection(question, both, " first\t");
    expect(buildPendingUserInputAnswers([question], { result: secondOnly })).toEqual({
      result: ["second"],
    });
  });
});

describe("isPendingUserInputOptionSelected", () => {
  it("matches selected options by value or padded label until a custom answer replaces them", () => {
    expect(
      isPendingUserInputOptionSelected(
        multiSelectQuestion,
        { selectedOptionValues: ["Web"] },
        "  Web  ",
      ),
    ).toBe(true);
    expect(
      isPendingUserInputOptionSelected(
        multiSelectQuestion,
        { selectedOptionValues: ["Web"], customAnswer: "Web first" },
        "Web",
      ),
    ).toBe(false);
    const first = togglePendingUserInputOptionSelection(
      offeredValuesOnlyQuestion,
      undefined,
      " first\t",
    );
    expect(isPendingUserInputOptionSelected(offeredValuesOnlyQuestion, first, " first\t")).toBe(
      true,
    );
    expect(isPendingUserInputOptionSelected(offeredValuesOnlyQuestion, first, "second")).toBe(
      false,
    );
  });
});

describe("buildPendingUserInputAnswers", () => {
  it("returns one answer per question, with arrays for multi-select", () => {
    expect(
      buildPendingUserInputAnswers([singleSelectQuestion, multiSelectQuestion], {
        scope: { customAnswer: "Keep the current envelope for one release window" },
        areas: { selectedOptionValues: ["Server", "Web"] },
      }),
    ).toEqual({
      scope: "Keep the current envelope for one release window",
      areas: ["Server", "Web"],
    });
  });

  it("returns null while any question is unanswered", () => {
    expect(
      buildPendingUserInputAnswers([singleSelectQuestion, multiSelectQuestion], {
        scope: { selectedOptionValues: ["UI-first"] },
      }),
    ).toBeNull();
    expect(
      buildPendingUserInputAnswers([offeredValuesOnlyQuestion], {
        result: { customAnswer: "Other" },
      }),
    ).toBeNull();
  });
});
