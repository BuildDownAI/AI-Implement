import { expect, it } from "vitest";
import { testDb } from "./helpers/test-db.js";

it("preserves the original private launch intent and bookkeeping across database reopen", async () => {
  const db = await testDb({ modules: { intent: () => import("../restate/implementation-launch-intent.js") } });
  const original = { nonce: "private-nonce", generation: 7, issue: { maxTurns: 17 }, backend: "local-docker" };
  db.modules.intent.implementationIntentStore().write("dispatch-1", original);
  const restarted = await db.reopen();
  const store = restarted.intent.implementationIntentStore();
  store.write("dispatch-1", { generation: 8 });
  expect(store.read("dispatch-1")).toEqual({ snapshot: original, done: false });
  store.complete("dispatch-1");
  expect(store.read("dispatch-1")).toEqual({ snapshot: original, done: true });
  store.remove("dispatch-1");
  expect(store.read("dispatch-1")).toBeNull();
});
