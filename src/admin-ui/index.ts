import { tokensCss } from "./tokens.js";
import { componentsCss } from "./components.js";

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

const body = `<body>
<div id="login-page" class="login-wrap">
  <div class="login-box card">
    <h2>Admin Access</h2>
    <input type="password" id="access-code" placeholder="Access code" autofocus>
    <button class="btn btn-primary" onclick="login()">Enter</button>
    <div id="login-error" class="error hidden"></div>
  </div>
</div>
<div id="admin-page" class="app-shell hidden">
  <aside class="sidebar"></aside>
  <main class="main"></main>
</div>
<script>/* placeholder — replaced in Task 6 */</script>
</body></html>`;

export const adminHtml = head + body;
