import { createFileRoute } from "@tanstack/react-router";

import { IssueBoardsSettings } from "../components/work/IssueBoardsSettings";

export const Route = createFileRoute("/settings/issue-boards")({
  component: IssueBoardsSettings,
});
