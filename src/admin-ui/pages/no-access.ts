/** Deliberately not a route: no nav entry, reached only as the router's fallback when nothing is granted. */
export const noAccessHtml = `
<section data-page="no-access" hidden>
  <header class="page-header">
    <div class="page-header-left">
      <h1 class="page-title">Nothing shared yet</h1>
      <div class="page-subtitle">Your account is signed in, and no admin page has been shared with it</div>
    </div>
  </header>
  <div class="page-body">
    <div class="alert info">
      <span class="alert-icon">&#x25CF;</span>
      <div>
        <div class="alert-title">This is not an error</div>
        <div class="alert-desc">
          An administrator chooses which pages users can open, and none has been chosen here yet.
          Your MCP server access is unaffected &#x2014; it comes with the account rather than with a page.
        </div>
      </div>
    </div>
  </div>
</section>`;
