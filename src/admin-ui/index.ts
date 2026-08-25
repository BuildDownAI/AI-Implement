import { tokensCss } from "./tokens.js";
import { componentsCss } from "./components.js";
import { sidebarHtml } from "./sidebar.js";
import { themeJs } from "./theme.js";
import { routerJs } from "./router.js";
import { authJs } from "./auth.js";
import { accessHtml, accessScript } from "./pages/access.js";
import { overviewHtml, overviewScript } from "./pages/overview.js";
import { settingsHtml, settingsScript } from "./pages/settings.js";
import { projectsHtml, projectsScript } from "./pages/projects.js";
import { pipelinesHtml, pipelinesScript } from "./pages/pipelines.js";
import { reaperHtml, reaperScript } from "./pages/reaper.js";
import { sessionsHtml, sessionsScript } from "./pages/sessions.js";
import { auditHtml, auditScript } from "./pages/audit.js";
import { issuesHtml, issuesScript } from "./pages/issues.js";
import { pullsHtml, pullsScript } from "./pages/pulls.js";
import { blockersHtml, blockersScript } from "./pages/blockers.js";
import { customizationsHtml, customizationsScript } from "./pages/customizations.js";
import { pipelinesAndStepsHtml, pipelinesAndStepsScript } from "./pages/pipelines-and-steps.js";
import { modelsAndProvidersHtml, modelsAndProvidersScript } from "./pages/models-and-providers.js";
import { runnersHtml, runnersScript } from "./pages/runners.js";
import { reportsHtml, reportsScript } from "./pages/reports.js";
import { deploymentsHtml, deploymentsScript } from "./pages/deployments.js";
import { stubsHtml } from "./pages/stubs.js";
import { drawerHtml, drawerScript } from "./drawer.js";
import { stepperHtml, stepperScript } from "./stepper.js";

const head = `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI-Implement · Orchestrator</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap">
<style>${tokensCss}${componentsCss}</style>
</head>`;

const shell = `<div id="admin-page" class="app-shell hidden">
  <aside class="sidebar">${sidebarHtml()}</aside>
  <main class="main">
    ${overviewHtml}
    ${settingsHtml}
    ${projectsHtml}
    ${pipelinesHtml}
    ${reaperHtml}
    ${sessionsHtml}
    ${auditHtml}
    ${issuesHtml}
    ${pullsHtml}
    ${blockersHtml}
    ${customizationsHtml}
    ${pipelinesAndStepsHtml}
    ${modelsAndProvidersHtml}
    ${runnersHtml}
    ${reportsHtml}
    ${deploymentsHtml}
    ${accessHtml}
    ${stubsHtml}
  </main>
</div>`;

const body = `<body>
<div id="login-page" class="login-wrap">
  <div class="login-panel">
    <h1 class="login-title">Admin Access</h1>
    <div class="login-box card">
      <div id="auth-error" class="error hidden"></div>
      <div id="sso-label" class="sso-label hidden">Sign in with your provider</div>
      <div id="sso-buttons"></div>
      <div id="login-divider" class="divider-labeled hidden"><span>or use an access code</span></div>
      <div id="access-code-notice" class="warning hidden">
        Signing in with an access code is <strong>deprecated</strong>.<br>
        Configure SSO via the <span class="mono">&lt;provider&gt;_OAUTH_*</span> environment variables for per-user login.
      </div>
      <div id="access-code-box">
        <div class="ac-row">
          <input type="password" id="access-code" class="input" placeholder="Access code (deprecated)">
          <button class="btn btn-primary" onclick="login()">Enter</button>
        </div>
        <div id="login-error" class="error hidden"></div>
      </div>
    </div>
  </div>
</div>
${shell}
${drawerHtml}
${stepperHtml}
<script>${themeJs}${authJs}${routerJs}${overviewScript}${settingsScript}${projectsScript}${pipelinesScript}${reaperScript}${sessionsScript}${auditScript}${issuesScript}${pullsScript}${blockersScript}${customizationsScript}${pipelinesAndStepsScript}${modelsAndProvidersScript}${runnersScript}${reportsScript}${deploymentsScript}${accessScript}${drawerScript}${stepperScript}</script>
</body></html>`;

export const adminHtml = head + body;
