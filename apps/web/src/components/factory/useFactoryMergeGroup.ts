import { useEffect, useRef } from "react";
import { factoryEnvironment, type FactoryEnvironmentView } from "../../state/factory";
import { useEnvironmentQuery } from "../../state/query";

export function useFactoryMergeGroup(environment: FactoryEnvironmentView, groupId: string) {
  const query = useEnvironmentQuery(
    factoryEnvironment.getMergeGroup({
      environmentId: environment.environmentId,
      input: { groupId },
    }),
  );
  const revision = environment.data?.revision;
  const refresh = query.refresh;
  const observed = useRef(revision);
  useEffect(() => {
    if (observed.current === revision) return;
    observed.current = revision;
    refresh();
  }, [revision, refresh]);
  return query;
}
