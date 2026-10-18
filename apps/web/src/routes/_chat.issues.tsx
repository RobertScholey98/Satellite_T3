import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { IssuesBoard } from "../components/work/IssuesBoard";
import {
  type IssuesSearch,
  readIssuesNavigation,
  resolveIssuesSearch,
  validateIssuesSearch,
} from "../components/work/issuesNavigation";

export const Route = createFileRoute("/_chat/issues")({
  validateSearch: validateIssuesSearch,
  component: IssuesRouteView,
});

const canonical = (search: IssuesSearch) =>
  JSON.stringify(Object.entries(search).toSorted(([left], [right]) => left.localeCompare(right)));

function IssuesRouteView() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  // Arriving fills what the link left out from this device's last selection, once; the URL is the
  // selection from then on.
  const [arrival, setArrival] = useState<IssuesSearch | null>(() => {
    const resolved = resolveIssuesSearch(search, readIssuesNavigation());
    return canonical(resolved) === canonical(search) ? null : resolved;
  });
  useEffect(() => {
    if (arrival) void navigate({ search: arrival, replace: true });
  }, []);
  useEffect(() => {
    if (arrival && canonical(search) === canonical(arrival)) setArrival(null);
  }, [search]);
  return (
    <IssuesBoard
      search={arrival ?? search}
      onSearchChange={(next, options) => {
        setArrival(null);
        void navigate({ search: next, replace: options?.replace ?? false });
      }}
    />
  );
}
