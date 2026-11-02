// Theme: system → light → dark. Loaded in <head> so the saved choice applies before first paint.
(function () {
  var root = document.documentElement;
  var order = ["system", "light", "dark"];
  var icons = {
    system: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="2" y="3" width="12" height="8" rx="1.5"/><path d="M6 14h4"/></svg>',
    light: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="8" cy="8" r="3"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6 13 13M3 13l1.4-1.4M11.6 4.4 13 3"/></svg>',
    dark: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7Z"/></svg>'
  };

  function read() {
    try { var m = localStorage.getItem("theme"); return order.indexOf(m) === -1 ? "system" : m; }
    catch (e) { return "system"; }
  }

  function apply(mode) {
    if (mode === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", mode);
  }

  var mode = read();
  apply(mode);

  document.addEventListener("DOMContentLoaded", function () {
    var btn = document.getElementById("theme");
    if (!btn) return;
    function show() {
      btn.innerHTML = icons[mode];
      btn.title = "Theme: " + mode;
      btn.setAttribute("aria-label", "Theme: " + mode + ". Switch theme");
    }
    btn.hidden = false;
    show();
    btn.addEventListener("click", function () {
      mode = order[(order.indexOf(mode) + 1) % order.length];
      apply(mode);
      try { localStorage.setItem("theme", mode); } catch (e) { /* storage blocked: theme still switches for this page */ }
      show();
    });
  });
})();
