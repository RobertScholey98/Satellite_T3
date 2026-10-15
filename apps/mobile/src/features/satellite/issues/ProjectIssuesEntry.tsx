import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import { Pressable } from "react-native";

import { AppText as Text } from "../../../components/AppText";
import { useServerConfigs } from "../../../state/entities";

/** Opens the ready issues of the scoped project when its environment serves issue boards. */
export function ProjectIssuesEntry(props: {
  readonly projectRefs: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
  }>;
}) {
  const navigation = useNavigation();
  const serverConfigs = useServerConfigs();
  const target = props.projectRefs.find(
    (ref) => serverConfigs.get(ref.environmentId)?.environment.capabilities.issueBoards === true,
  );
  if (!target) return null;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() =>
        navigation.navigate("ProjectIssues", {
          environmentId: String(target.environmentId),
          projectId: String(target.projectId),
        })
      }
      className="mx-4 my-2 rounded-xl border border-border bg-surface px-4 py-3 active:opacity-70"
    >
      <Text className="font-t3-medium text-foreground">Ready issues</Text>
      <Text className="text-sm text-foreground-muted">Start work on an issue from its board</Text>
    </Pressable>
  );
}
