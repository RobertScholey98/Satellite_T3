import {
  createNativeStackScreen,
  type NativeStackNavigationOptions,
} from "@react-navigation/native-stack";

import { ThreadDocumentsScreen } from "../documents/ThreadDocumentsScreen";
import { IdeaRouteScreen, IdeasRouteScreen } from "../ideas/IdeasRouteScreen";
import { ProjectIssuesRouteScreen } from "./issues/ProjectIssuesRouteScreen";

/** Satellite's root stack screens. The root stack spreads them into its screen list. */
export function satelliteScreens(input: {
  readonly headerOptions: NativeStackNavigationOptions;
  readonly threadLinkingPrefix: string;
}) {
  return {
    Ideas: createNativeStackScreen({
      screen: IdeasRouteScreen,
      linking: "ideas",
      options: input.headerOptions,
    }),
    Idea: createNativeStackScreen({
      screen: IdeaRouteScreen,
      linking: "ideas/:environmentId/:threadId",
      options: input.headerOptions,
    }),
    ProjectIssues: createNativeStackScreen({
      screen: ProjectIssuesRouteScreen,
      linking: "issues/:environmentId/:projectId",
      options: { ...input.headerOptions, title: "Issues" },
    }),
    ThreadDocuments: createNativeStackScreen({
      screen: ThreadDocumentsScreen,
      linking: `${input.threadLinkingPrefix}/documents`,
      options: { ...input.headerOptions, title: "Documents" },
    }),
  };
}
