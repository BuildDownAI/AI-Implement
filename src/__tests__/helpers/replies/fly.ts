// fakeFetch replies shaped like Fly's Machines API (api.machines.dev), for the responses several test files fake
// the same way. See ../README.md.
import type { ReplyInit } from "../fake-fetch.js";

/** The answer to `POST /v1/apps/{app_name}/secrets` (`AppSecretsUpdateResp` in Fly's OpenAPI spec): the app's new
 *  secrets version, under `version` and the deprecated `Version`. */
export function flySecretsUpdated(version: number): ReplyInit {
  return { json: { Version: version, version } };
}
