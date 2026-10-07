import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  DraftId,
  finalizePromotedDraftThreadByRef,
  markPromotedDraftThreadByRef,
  useComposerDraftStore,
} from "../composerDraftStore";
import { resolveThreadDetailRef } from "./entities";

const threadRef = scopeThreadRef(EnvironmentId.make("environment-1"), ThreadId.make("thread-1"));

describe("resolveThreadDetailRef", () => {
  it("loads an idea detail only after creation is accepted, without requiring a work shell", () => {
    const draftId = DraftId.make("new-idea");
    useComposerDraftStore.setState({
      draftsByThreadKey: {},
      draftThreadsByThreadKey: {},
      logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    });
    useComposerDraftStore
      .getState()
      .setProjectDraftThreadId(
        { environmentId: threadRef.environmentId, projectId: ProjectId.make("project-1") },
        draftId,
        { threadId: threadRef.threadId, purpose: "idea" },
      );
    const detailRef = () =>
      resolveThreadDetailRef(threadRef, {
        shellExists: false,
        draftThread: useComposerDraftStore.getState().getDraftSession(draftId),
      });

    // Looking up the reserved ID here would cache a terminal HTTP 404.
    expect(detailRef()).toBeNull();
    markPromotedDraftThreadByRef(threadRef);
    expect(detailRef()).toBe(threadRef);
    finalizePromotedDraftThreadByRef(threadRef);
    expect(detailRef()).toBe(threadRef);
  });

  it("does not subscribe to a reserved draft thread before it enters the shell index", () => {
    expect(
      resolveThreadDetailRef(threadRef, {
        shellExists: false,
        draftThread: { purpose: "work", promotedTo: null },
      }),
    ).toBeNull();
  });

  it("subscribes once the reserved draft thread enters the shell index", () => {
    expect(
      resolveThreadDetailRef(threadRef, {
        shellExists: true,
        draftThread: { purpose: "work", promotedTo: threadRef },
      }),
    ).toBe(threadRef);
  });

  it("keeps direct server-thread lookups enabled when the shell has not loaded it", () => {
    expect(
      resolveThreadDetailRef(threadRef, {
        shellExists: false,
        draftThread: null,
      }),
    ).toBe(threadRef);
  });

  it("keeps work drafts waiting for their shell while promotion is in flight", () => {
    expect(
      resolveThreadDetailRef(threadRef, {
        shellExists: false,
        draftThread: { purpose: "work", promotedTo: threadRef },
      }),
    ).toBeNull();
  });

  it("does not use an idea receipt from another environment to load a reserved ID", () => {
    expect(
      resolveThreadDetailRef(threadRef, {
        shellExists: false,
        draftThread: {
          purpose: "idea",
          promotedTo: scopeThreadRef(EnvironmentId.make("environment-2"), threadRef.threadId),
        },
      }),
    ).toBeNull();
  });
});
