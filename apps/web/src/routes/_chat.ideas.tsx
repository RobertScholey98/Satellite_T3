import { createFileRoute } from "@tanstack/react-router";
import { IdeasPage } from "../components/ideas/IdeasPage";

export const Route = createFileRoute("/_chat/ideas")({
  validateSearch: (search: Record<string, unknown>) => ({
    environment: typeof search.environment === "string" ? search.environment : undefined,
    idea: typeof search.idea === "string" ? search.idea : undefined,
  }),
  component: IdeasRoute,
});

function IdeasRoute() {
  const search = Route.useSearch();
  return <IdeasPage environment={search.environment} idea={search.idea} />;
}
