import {
  createNativeStackScreen,
  type NativeStackNavigationOptions,
} from "@react-navigation/native-stack";

import { ThreadDocumentsScreen } from "../documents/ThreadDocumentsScreen";
import { IdeaRouteScreen, IdeasRouteScreen } from "../ideas/IdeasRouteScreen";

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
    ThreadDocuments: createNativeStackScreen({
      screen: ThreadDocumentsScreen,
      linking: `${input.threadLinkingPrefix}/documents`,
      options: { ...input.headerOptions, title: "Documents" },
    }),
  };
}
