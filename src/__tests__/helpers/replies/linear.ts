// fakeFetch routes and replies shaped like Linear's GraphQL API (AII-1076), for the responses several test files
// fake the same way. See docs/unit-tests.md § Harnesses.
import { fakeFetch, type FakeFetch, type Reply } from "./fake-fetch.js";

/** One GraphQL response carrying `data`, as Linear's API answers a request that succeeds. */
export function linearData(data: unknown): Reply {
  return { json: { data } };
}

/** Linear's GraphQL endpoint answering `replies` in order, one per request; a request past the last fails the test.
 *  Pass `fake.fetch` where the code takes `fetchImpl`, or call `install()`. */
export function linearGraphql(...replies: Reply[]): FakeFetch {
  return fakeFetch({ "POST /graphql": replies });
}
