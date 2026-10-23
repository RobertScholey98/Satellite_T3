import { createFileRoute, redirect } from "@tanstack/react-router";

import { FactoryPage } from "../components/factory/FactoryPage";

export const Route = createFileRoute("/factory")({
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: FactoryPage,
});
