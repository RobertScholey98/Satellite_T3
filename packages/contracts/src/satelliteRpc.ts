import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";

import { EnvironmentAuthorizationError } from "./auth.ts";
import {
  IdeaChange,
  IdeaGetInput,
  IdeaGetResult,
  IdeaListInput,
  IdeaListResult,
  IdeaOperationError,
} from "./ideas.ts";

/** Satellite's WebSocket methods. `WS_METHODS` spreads this table, so clients use either name. */
export const SATELLITE_WS_METHODS = {
  ideasList: "ideas.list",
  ideasGet: "ideas.get",
  ideasSubscribeChanges: "ideas.subscribeChanges",
} as const;

const ideaRpcError = Schema.Union([IdeaOperationError, EnvironmentAuthorizationError]);

/**
 * The RPCs Satellite adds to upstream's surface; `WsRpcGroup` merges this group into
 * `WsCoreRpcGroup`. The server implements it in its own handler layer: a single `toLayer` over
 * every RPC exceeds the compiler's instantiation limit, which silently widens the server layer's
 * requirements to `any`.
 */
export const WsSatelliteRpcGroup = RpcGroup.make(
  Rpc.make(SATELLITE_WS_METHODS.ideasList, {
    payload: IdeaListInput,
    success: IdeaListResult,
    error: ideaRpcError,
  }),
  Rpc.make(SATELLITE_WS_METHODS.ideasGet, {
    payload: IdeaGetInput,
    success: IdeaGetResult,
    error: ideaRpcError,
  }),
  Rpc.make(SATELLITE_WS_METHODS.ideasSubscribeChanges, {
    payload: Schema.Struct({}),
    success: IdeaChange,
    error: ideaRpcError,
    stream: true,
  }),
);

export type SatelliteWsRpcMethod = RpcGroup.Rpcs<typeof WsSatelliteRpcGroup>["_tag"];
