import { CircleIcon } from "lucide-react";
import { Children, isValidElement, type ReactNode } from "react";
import { describe, expect, it } from "vite-plus/test";

import { PullRequestFiltersMenu } from "./PullRequestListFilters";

function badgeCount(node: ReactNode): number {
  for (const child of Children.toArray(node)) {
    if (!isValidElement(child)) continue;
    const props = child.props as { readonly children?: ReactNode };
    if (typeof props.children === "number") return props.children;
    const nested = badgeCount(props.children);
    if (nested > 0) return nested;
  }
  return 0;
}

function menu(overrides: Partial<Parameters<typeof PullRequestFiltersMenu>[0]>) {
  return PullRequestFiltersMenu({
    state: "open",
    stateOptions: [
      { value: "open", label: "Open", Icon: CircleIcon },
      { value: "closed", label: "Closed", Icon: CircleIcon },
    ],
    onState: () => undefined,
    involvement: "all",
    involvementOptions: [{ value: "all", label: "All", Icon: CircleIcon }],
    onInvolvement: () => undefined,
    filters: {},
    optionScope: [],
    onFilters: () => undefined,
    host: undefined,
    hostOptions: [],
    onHost: () => undefined,
    server: undefined,
    serverOptions: [],
    onServer: () => undefined,
    projects: [],
    projectId: undefined,
    projectEnvironmentId: undefined,
    unavailable: new Map(),
    onProject: () => undefined,
    includeUpstream: false,
    onIncludeUpstream: () => undefined,
    ...overrides,
  });
}

describe("pull request filters menu", () => {
  it("counts included upstream pull requests as a filter", () => {
    expect(badgeCount(menu({}))).toBe(0);
    expect(badgeCount(menu({ includeUpstream: true }))).toBe(1);
    expect(badgeCount(menu({ includeUpstream: true, state: "closed" }))).toBe(2);
  });
});
