// The hero's entrance and the moments' guard (taste-skill motion.md, moments.md). Loaded in <head>
// before first paint, as a file because the CSP allows no inline script.
(function () {
  var root = document.documentElement;
  root.classList.add("m-enter", "mo-js");
  setTimeout(function () { root.classList.add("m-enter-done"); }, 700);
  setTimeout(function () { root.classList.add("mo-safe"); }, 2500);
})();
