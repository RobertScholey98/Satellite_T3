// @effect-diagnostics nodeBuiltinImport:off - checks the report's file list against the checkout.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

import { REGISTRATION_POINTS } from "./fork-footprint.ts";

it("measures registration points that exist in this checkout", () => {
  const root = NodePath.dirname(import.meta.dirname);
  expect(
    REGISTRATION_POINTS.filter((file) => !NodeFS.existsSync(NodePath.join(root, file))),
  ).toEqual([]);
});
