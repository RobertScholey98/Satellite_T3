import {
  activeCommitRecommendation,
  commitRecommendationLabel,
} from "@t3tools/client-runtime/commit-recommendation";
import type { VcsStatusResult } from "@t3tools/contracts";
import { Pressable, View } from "react-native";
import { AppText as Text } from "../../../components/AppText";
import { threadEnvironment } from "../../../state/threads";
import { useAtomCommand } from "../../../state/use-atom-command";
import { useThreadSelection } from "../../../state/use-thread-selection";
import { useSelectedThreadWorktree } from "../../../state/use-selected-thread-worktree";

export function CommitRecommendationNotice({
  status,
}: {
  readonly status: VcsStatusResult | null | undefined;
}) {
  const { selectedThread } = useThreadSelection();
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  const updateMetadata = useAtomCommand(threadEnvironment.updateMetadata);
  const recommendation = activeCommitRecommendation(
    selectedThread?.commitRecommendation,
    status,
    selectedThreadCwd,
  );
  if (!recommendation || !selectedThread) return null;

  return (
    <View
      className={
        recommendation.level === "overdue"
          ? "rounded-xl border border-danger-border bg-danger p-4"
          : "rounded-xl border border-warning-border bg-warning p-4"
      }
    >
      <Text
        className={
          recommendation.level === "overdue"
            ? "text-base font-semibold text-danger-foreground"
            : "text-base font-semibold text-warning-foreground"
        }
      >
        {commitRecommendationLabel(recommendation)}
      </Text>
      <Text className="mt-1 text-sm text-foreground">{recommendation.reason}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Dismiss commit suggestion"
        className="min-h-11 justify-center self-start"
        onPress={() =>
          void updateMetadata({
            environmentId: selectedThread.environmentId,
            input: { threadId: selectedThread.id, commitRecommendation: null },
          })
        }
      >
        <Text className="text-sm text-foreground underline">Dismiss suggestion</Text>
      </Pressable>
    </View>
  );
}
