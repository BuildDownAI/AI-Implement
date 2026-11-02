---
target: orchestrator
auth: admin
timeout_minutes: 10
---

# Wide admin tables scroll inside their cards (AII-1637)

Manual browser check with populated Projects rows. Opening Edit is sufficient; do not save mapping changes.

## Steps

1. Sign in to `/admin#projects` on a build containing AII-1637. Set the browser viewport to 375 px wide, or use a phone of that width.
2. Swipe the Projects table horizontally to its right edge. Tap each row's **Edit** button and verify the dialog identifies the selected project; close it without saving.
3. Confirm the page stays fixed horizontally while the table moves. Run the phone assertions below in the browser console.
4. At a desktop viewport wide enough for the table to fit (for example 1920 px), confirm the table/card appearance is unchanged and there is no horizontal scrollbar. Run the desktop assertion.
5. Check an empty Projects table on a test instance with no mappings, and the already-wrapped tables on Models and Providers. Confirm no unnecessary scrollbar or clipped inline controls.

## Asserts

Phone, on Projects:

```js
const container = document.querySelector('#mappings-body').closest('.card-body.tight');
console.assert(getComputedStyle(container).overflowX === 'auto');
console.assert(container.scrollWidth > container.clientWidth);
console.assert(document.documentElement.scrollWidth <= document.documentElement.clientWidth);
```

Desktop, on Projects, with a viewport wide enough for the populated table:

```js
const container = document.querySelector('#mappings-body').closest('.card-body.tight');
console.assert(container.scrollWidth === container.clientWidth);
```
