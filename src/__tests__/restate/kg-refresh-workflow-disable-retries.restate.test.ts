// The disableRetries half of the KgRefresh workflow scenarios; the other variant runs in its own file so
// vitest schedules them in two forks (AII-1159).
import { defineKgRefreshWorkflowScenarios } from "./kg-refresh-workflow-scenarios.js";

defineKgRefreshWorkflowScenarios(["disableRetries"]);
