import type { EnvironmentId } from "@t3tools/contracts";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { ideaEnvironment } from "../../state/ideas";
import { useEnvironmentQuery } from "../../state/query";
import { SidebarUtilityMenu } from "../sidebar/SidebarChrome";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import {
  SidebarContent,
  SidebarFooter,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "../ui/sidebar";

export function IdeasSidebar() {
  const { environments } = useEnvironments();
  const projects = useProjects();
  // The root shell mounts this sidebar before the Ideas route has an active match.
  const { environment, idea } = useLocation({
    select: ({ search }) => ({
      environment: typeof search.environment === "string" ? search.environment : undefined,
      idea: typeof search.idea === "string" ? search.idea : undefined,
    }),
    structuralSharing: true,
  });
  const [filter, setFilter] = useState("");
  const [projectFilter, setProjectFilter] = useState("");
  const projectOptions = [
    { value: "", label: "All projects" },
    ...projects.map((project) => ({
      value: `${project.environmentId}:${project.id}`,
      label: `${project.title} · ${environments.find((item) => item.environmentId === project.environmentId)?.label ?? ""}`,
    })),
  ];

  return (
    <>
      <div className="relative z-[1] space-y-2 p-3">
        <Input
          aria-label="Find an idea"
          placeholder="Find an idea"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        <Select
          items={projectOptions}
          value={projectFilter}
          onValueChange={(value) => setProjectFilter(value ?? "")}
        >
          <SelectTrigger size="sm" aria-label="Filter ideas by project">
            <SelectValue placeholder="All projects" />
          </SelectTrigger>
          <SelectPopup>
            {projectOptions.map(({ value, label }) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
      <SidebarContent>
        {environments.map((item) => (
          <EnvironmentIdeas
            key={item.environmentId}
            environmentId={item.environmentId}
            label={item.label}
            filter={filter}
            projectFilter={projectFilter}
            selectedId={item.environmentId === environment ? idea : undefined}
          />
        ))}
        {environments.length === 0 ? (
          <p className="p-4 text-sm text-sidebar-muted-foreground">
            Connect to an environment to see its ideas.
          </p>
        ) : null}
      </SidebarContent>
      <SidebarFooter>
        <p className="px-2 pb-2 text-xs leading-5 text-sidebar-muted-foreground">
          Start an idea by selecting Idea in a new thread.
        </p>
        <SidebarUtilityMenu />
      </SidebarFooter>
    </>
  );
}

function EnvironmentIdeas({
  environmentId,
  label,
  filter,
  projectFilter,
  selectedId,
}: {
  environmentId: EnvironmentId;
  label: string;
  filter: string;
  projectFilter: string;
  selectedId?: string | undefined;
}) {
  const query = useEnvironmentQuery(ideaEnvironment.list({ environmentId, input: {} }));
  const projects = useProjects();
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const ideas =
    query.data?.ideas.filter(
      (item) =>
        (!projectFilter || `${environmentId}:${item.projectId}` === projectFilter) &&
        `${item.title} ${item.excerpt}`.toLowerCase().includes(filter.toLowerCase()),
    ) ?? [];
  return (
    <div className="px-2 pb-3">
      {query.error ? (
        <div className="space-y-2 p-2 text-xs text-sidebar-muted-foreground">
          <p>
            {label}: {query.error}
          </p>
          <Button size="xs" variant="outline" onClick={query.refresh}>
            Retry
          </Button>
        </div>
      ) : null}
      {query.isPending && !query.data ? (
        <p className="p-2 text-xs text-sidebar-muted-foreground">Loading {label}…</p>
      ) : null}
      {query.data?.ideas.length === 0 ? (
        <p className="p-2 text-xs text-sidebar-muted-foreground">No ideas in {label} yet.</p>
      ) : null}
      {query.data &&
      query.data.ideas.length > 0 &&
      ideas.length === 0 &&
      (filter || projectFilter) ? (
        <p className="p-2 text-xs text-sidebar-muted-foreground">No matching ideas in {label}.</p>
      ) : null}
      {["active", "settled", "deleting"].map((status) => {
        const group = ideas.filter((item) => item.status === status);
        if (!group.length) return null;
        const content = (
          <>
            {Array.from(new Set(group.map((item) => item.projectId))).map((projectId) => (
              <div key={projectId} className="mb-3">
                <p className="px-2 py-2 text-xs text-sidebar-muted-foreground">
                  {projects.find(
                    (item) => item.environmentId === environmentId && item.id === projectId,
                  )?.title ?? "Project"}
                  <span className="opacity-60"> · {label}</span>
                </p>
                <SidebarMenu>
                  {group
                    .filter((item) => item.projectId === projectId)
                    .map((item) => (
                      <SidebarMenuItem key={item.threadId}>
                        <SidebarMenuButton
                          size="lg"
                          isActive={selectedId === item.threadId}
                          aria-current={selectedId === item.threadId ? "page" : undefined}
                          onClick={() => {
                            if (isMobile) setOpenMobile(false);
                            void navigate({
                              to: "/ideas",
                              search: { environment: environmentId, idea: item.threadId },
                            });
                          }}
                        >
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm leading-4">{item.title}</span>
                            <span className="block truncate text-xs leading-4 text-sidebar-muted-foreground">
                              {item.status === "deleting"
                                ? (item.deletionError ?? "Deleting…")
                                : item.excerpt || "The pitch will grow with the conversation."}
                            </span>
                          </span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                </SidebarMenu>
              </div>
            ))}
          </>
        );
        return status === "settled" ? (
          <Collapsible key={status}>
            <CollapsibleTrigger render={<Button variant="ghost" size="xs" />}>
              Settled · {group.length}
            </CollapsibleTrigger>
            <CollapsiblePanel keepMounted>{content}</CollapsiblePanel>
          </Collapsible>
        ) : (
          <div key={status}>{content}</div>
        );
      })}
    </div>
  );
}
