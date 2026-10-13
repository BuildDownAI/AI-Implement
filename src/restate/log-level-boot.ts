// Must be the first import of src/index.ts. The Restate SDK reads RESTATE_LOGGING once, when
// @restatedev/restate-sdk first loads, so the default has to be in place before any module that
// imports the SDK is evaluated. This module must never import one (directly or transitively);
// it imports only ./log-level.js, which has no imports of its own (AII-1189).
import { resolveRestateLogLevel } from "./log-level.js";

process.env.RESTATE_LOGGING = resolveRestateLogLevel(process.env.RESTATE_LOGGING);
