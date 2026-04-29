export const themeJs = `
(function () {
  const KEY = 'ai-impl-theme';
  const stored = localStorage.getItem(KEY) || 'dark';
  document.documentElement.setAttribute('data-theme', stored);
  document.documentElement.setAttribute('data-accent', 'violet');
  window.toggleTheme = function () {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem(KEY, next);
  };
})();
`;
