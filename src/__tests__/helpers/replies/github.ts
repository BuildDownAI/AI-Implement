// fakeFetch replies shaped like GitHub's REST API (AII-1073), for the responses several test files fake
// the same way. See ../README.md.
import type { Reply } from "../fake-fetch.js";

/** The contents API's answer for a file (`GET /repos/{owner}/{repo}/contents/{path}`): its text, base64-encoded. */
export function githubFile(text: string): Reply {
  return { json: { type: "file", encoding: "base64", content: Buffer.from(text, "utf8").toString("base64") } };
}

/** GitHub's error body for a failed request: the message, a docs link, and the status as a string. */
export function githubError(status: number, message: string): Reply {
  return { status, json: { message, documentation_url: "https://docs.github.com/rest", status: String(status) } };
}
