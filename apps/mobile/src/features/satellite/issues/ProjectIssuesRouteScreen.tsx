import { validWorktreeName } from "@t3tools/client-runtime/turn-delivery";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, TextInput, View } from "react-native";

import { AppText as Text } from "../../../components/AppText";
import { EmptyState } from "../../../components/EmptyState";
import { MaterialButton } from "../../../components/MaterialButton";
import { makeTurnCommandMetadata } from "../../../lib/commandMetadata";
import {
  buildModelOptions,
  resolveDefaultableModelSelection,
  resolveNewTaskModelSelection,
} from "../../../lib/modelOptions";
import { uuidv4 } from "../../../lib/uuid";
import { NativeStackScreenOptions } from "../../../native/StackHeader";
import { useProjects, useServerConfigs } from "../../../state/entities";
import { issuesEnvironment } from "../../../state/issues";
import { useEnvironmentQuery } from "../../../state/query";
import { enqueueThreadOutboxMessage } from "../../../state/thread-outbox";
import { useAtomCommand } from "../../../state/use-atom-command";
import { useStickyComposerModelSelection } from "../../../state/use-composer-drafts";
import { vcsEnvironment } from "../../../state/vcs";
import { issueStartTask, loadReadyIssues, type ReadyIssue } from "./issueStart";

type ProjectIssuesProps = StaticScreenProps<{ environmentId: string; projectId: string }>;

type ReadyIssuesState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly issues: ReadonlyArray<ReadyIssue> }
  | { readonly status: "error"; readonly error: string };

function useProjectReadyIssues(environmentId: EnvironmentId, projectId: ProjectId) {
  const listBoards = useAtomCommand(issuesEnvironment.listBoards, { reportFailure: false });
  const openBoard = useAtomCommand(issuesEnvironment.openBoard, { reportFailure: false });
  const [state, setState] = useState<ReadyIssuesState>({ status: "loading" });
  useEffect(() => {
    let live = true;
    void loadReadyIssues({ environmentId, projectId, listBoards, openBoard }).then((result) => {
      if (!live) return;
      setState(
        "error" in result
          ? { status: "error", error: result.error }
          : { status: "ready", issues: result.issues },
      );
    });
    return () => {
      live = false;
    };
  }, [environmentId, listBoards, openBoard, projectId]);
  return state;
}

/** Ready issues for one project, each with a Start action that queues work in a new worktree. */
export function ProjectIssuesRouteScreen(props: ProjectIssuesProps) {
  const [attempt, setAttempt] = useState(0);
  return (
    <ProjectIssues key={attempt} {...props} onRetry={() => setAttempt((current) => current + 1)} />
  );
}

function ProjectIssues(props: ProjectIssuesProps & { readonly onRetry: () => void }) {
  const navigation = useNavigation();
  const environmentId = EnvironmentId.make(props.route.params.environmentId);
  const projectId = ProjectId.make(props.route.params.projectId);
  const project = useProjects().find(
    (candidate) => candidate.environmentId === environmentId && candidate.id === projectId,
  );
  const serverConfig = useServerConfigs().get(environmentId) ?? null;
  const stickyModelSelection = useStickyComposerModelSelection();
  const gitStatus = useEnvironmentQuery(
    project
      ? vcsEnvironment.status({ environmentId, input: { cwd: project.workspaceRoot } })
      : null,
  );
  const baseBranch = gitStatus.data?.refName ?? null;
  const modelSelection = resolveNewTaskModelSelection({
    draftSelection: null,
    projectDefaultSelection: resolveDefaultableModelSelection(
      serverConfig,
      project?.defaultModelSelection ?? null,
    ),
    stickySelection: resolveDefaultableModelSelection(serverConfig, stickyModelSelection),
    modelOptions: buildModelOptions(serverConfig, null),
  });
  const state = useProjectReadyIssues(environmentId, projectId);
  const [selected, setSelected] = useState<{ key: string; worktreeName: string } | null>(null);
  const [starting, setStarting] = useState(false);

  const start = async (readyIssue: ReadyIssue, worktreeName: string) => {
    if (!project || baseBranch === null || modelSelection === null) return;
    const task = issueStartTask({
      project,
      readyIssue,
      worktreeName,
      baseBranch,
      modelSelection,
      ids: { ...makeTurnCommandMetadata(), requestId: uuidv4() },
    });
    setStarting(true);
    try {
      await enqueueThreadOutboxMessage(task);
    } catch (error) {
      Alert.alert(
        "Could not start issue work",
        error instanceof Error ? error.message : "The task could not be saved to the outbox.",
      );
      return;
    } finally {
      setStarting(false);
    }
    navigation.dispatch(
      StackActions.replace("Thread", {
        environmentId: String(task.environmentId),
        threadId: String(task.threadId),
      }),
    );
  };

  const blockedReason = !project
    ? "This project is not loaded yet."
    : baseBranch === null
      ? "Check out a branch in this project to start issue work from it."
      : modelSelection === null
        ? "Set up a model on this environment to start issue work."
        : null;

  return (
    <View className="flex-1 bg-screen">
      <NativeStackScreenOptions
        options={{ title: project ? `${project.title} issues` : "Issues" }}
      />
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="gap-3 p-4">
        {blockedReason ? (
          <Text className="text-sm text-foreground-muted">{blockedReason}</Text>
        ) : null}
        {state.status === "loading" ? (
          <Text className="text-sm text-foreground-muted">Loading ready issues…</Text>
        ) : state.status === "error" ? (
          <EmptyState
            title="Issues could not load"
            detail={state.error}
            actionLabel="Retry"
            onAction={props.onRetry}
          />
        ) : state.issues.length === 0 ? (
          <EmptyState
            title="No ready issues"
            detail="Issues in a Ready column of this project's connected boards appear here."
          />
        ) : (
          state.issues.map((readyIssue) => {
            const key = `${readyIssue.boardId}:${readyIssue.issue.ref.id}`;
            const editing = selected?.key === key ? selected : null;
            return (
              <View key={key} className="gap-3 rounded-xl border border-border bg-surface p-4">
                <Pressable
                  accessibilityRole="button"
                  onPress={() =>
                    setSelected(
                      editing
                        ? null
                        : { key, worktreeName: `issue-${readyIssue.issue.ref.number}` },
                    )
                  }
                >
                  <Text className="font-t3-medium text-foreground">
                    #{readyIssue.issue.ref.number} {readyIssue.issue.title}
                  </Text>
                  <Text className="text-sm text-foreground-muted">{readyIssue.boardTitle}</Text>
                </Pressable>
                {editing ? (
                  <View className="gap-2">
                    <TextInput
                      accessibilityLabel="Worktree name"
                      autoCapitalize="none"
                      autoCorrect={false}
                      value={editing.worktreeName}
                      onChangeText={(worktreeName) => setSelected({ key, worktreeName })}
                      className="rounded-xl border border-border bg-screen px-4 py-3 text-foreground"
                    />
                    {validWorktreeName(editing.worktreeName) ? null : (
                      <Text className="text-sm text-danger">Use a valid Git branch name.</Text>
                    )}
                    <MaterialButton
                      label="Start"
                      tone="primary"
                      loading={starting}
                      disabled={blockedReason !== null || !validWorktreeName(editing.worktreeName)}
                      onPress={() => void start(readyIssue, editing.worktreeName)}
                    />
                  </View>
                ) : null}
              </View>
            );
          })
        )}
      </ScrollView>
    </View>
  );
}
