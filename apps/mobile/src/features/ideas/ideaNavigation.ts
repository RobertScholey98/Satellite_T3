import { useCallback } from "react";
import { useNavigation } from "@react-navigation/native";
import { readLastIdea } from "./ideaWorkspace";

export function useOpenIdeas() {
  const navigation = useNavigation();
  return useCallback(() => {
    const previous = readLastIdea();
    if (previous) navigation.navigate("Idea", previous);
    else navigation.navigate("Ideas");
  }, [navigation]);
}
