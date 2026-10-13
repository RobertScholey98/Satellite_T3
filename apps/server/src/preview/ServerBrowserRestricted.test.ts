// @effect-diagnostics nodeBuiltinImport:off - These owned loopback HTTP fixtures prove native browser network confinement.
import * as NodeHttp from "node:http";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, ThreadId, type PreviewAutomationSnapshot } from "@t3tools/contracts";
import { chromium } from "playwright-core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Broker from "../mcp/PreviewAutomationBroker.ts";
import * as Manager from "./Manager.ts";
import * as DesktopChannel from "./DesktopBrowserChannel.ts";
import * as PreviewBrowser from "./PreviewBrowser.ts";
import * as ServerBrowser from "./ServerBrowser.ts";

const fixture = (handler: NodeHttp.RequestListener) =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<{ server: NodeHttp.Server; origin: string }>((resolve, reject) => {
          const server = NodeHttp.createServer(handler);
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            if (!address || typeof address === "string")
              return reject(new Error("No fixture port"));
            resolve({ server, origin: `http://127.0.0.1:${address.port}` });
          });
        }),
    ),
    ({ server }) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
  );
const services = ServerBrowser.layer
  .pipe(
    Layer.provide(
      Layer.mergeAll(
        Broker.layer,
        Manager.layer,
        DesktopChannel.layer,
        Layer.succeed(ServerEnvironment.ServerEnvironment, {
          getEnvironmentId: Effect.succeed(EnvironmentId.make("restricted-preview-test")),
          getDescriptor: Effect.die("Unused environment descriptor"),
        }),
        Layer.mock(PreviewBrowser.PreviewBrowser)({
          executable: Effect.succeed(
            process.env.SATELLITE_FACTORY_BROWSER_EXECUTABLE ?? chromium.executablePath(),
          ),
        }),
      ),
    ),
  )
  .pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "restricted-preview-" })),
    Layer.provideMerge(NodeServices.layer),
  );

it.live(
  "native candidate tab blocks foreign navigation, redirect chains, and subresources",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const foreignRequests: string[] = [];
        const foreign = yield* fixture((request, response) => {
          foreignRequests.push(request.url ?? "/");
          response.end("must never be read");
        });
        const app = yield* fixture((request, response) => {
          if (request.url === "/redirect") {
            response.writeHead(302, { location: "/redirect-again" });
            response.end();
            return;
          }
          if (request.url === "/redirect-again") {
            response.writeHead(302, { location: `${foreign.origin}/redirect-escape` });
            response.end();
            return;
          }
          response.setHeader("Content-Type", "text/html");
          response.end(`<html><body><h1>Candidate</h1><script>
      Promise.allSettled([
        fetch('${foreign.origin}/fetch-escape'),
        fetch('/redirect'),
        new Promise(resolve => { const image=new Image(); image.onload=image.onerror=resolve; image.src='${foreign.origin}/image-escape'; document.body.append(image); })
      ]).then(() => { const button=document.createElement('button'); button.textContent='Ready'; button.onclick=()=>document.querySelector('h1').textContent='Verified interaction'; document.body.append(button); });
    </script></body></html>`);
        });
        const browser = yield* ServerBrowser.ServerBrowser;
        const owner = {
          sessionId: "confined-candidate",
          threadId: ThreadId.make("reviewer"),
          origin: app.origin,
        };
        yield* browser.invokeRestricted({
          ...owner,
          operation: "navigate",
          input: { url: app.origin },
        });
        yield* browser.invokeRestricted({
          ...owner,
          operation: "click",
          input: { locator: "role=button[name=Ready]" },
        });
        const snapshot = yield* browser.invokeRestricted({
          ...owner,
          operation: "snapshot",
          input: {},
        });
        assert.include((snapshot as PreviewAutomationSnapshot).visibleText, "Verified interaction");
        assert.isTrue((snapshot as PreviewAutomationSnapshot).screenshot.data.startsWith("iVBOR"));
        yield* browser
          .invokeRestricted({
            ...owner,
            operation: "navigate",
            input: { url: `${foreign.origin}/direct-navigation` },
          })
          .pipe(Effect.asVoid, Effect.flip);
        assert.deepEqual(foreignRequests, []);
        yield* browser.closeRestricted(owner.sessionId);
      }),
    ).pipe(Effect.provide(services)),
  30_000,
);
