// Copy buttons stay hidden without JavaScript or clipboard access.
if (navigator.clipboard?.writeText) {
  for (const button of document.querySelectorAll("button[data-copy]")) {
    const command = button.dataset.copy ?? "";
    const idleLabel = `Copy ${command}`;
    button.hidden = false;
    button.setAttribute("aria-label", idleLabel);
    let reset;
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(command);
        button.textContent = "Copied";
        button.dataset.state = "copied";
        button.setAttribute("aria-label", `Copied ${command}`);
      } catch {
        button.textContent = "Copy failed";
        button.setAttribute("aria-label", `Could not copy ${command}`);
      }
      clearTimeout(reset);
      reset = setTimeout(() => {
        button.textContent = "Copy";
        delete button.dataset.state;
        button.setAttribute("aria-label", idleLabel);
      }, 1800);
    });
  }
}

// Feature tabs. Without JavaScript every panel shows, one after another.
const tablist = document.querySelector('[role="tablist"]');
if (tablist) {
  const tabs = [...tablist.querySelectorAll('[role="tab"]')];
  const panels = tabs.map((tab) => document.getElementById(tab.dataset.panel));

  const select = (index, focus) => {
    tabs.forEach((tab, i) => {
      const selected = i === index;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      panels[i].hidden = !selected;
    });
    if (focus) tabs[index].focus();
  };

  tabs.forEach((tab, i) => {
    tab.id = `tab-${tab.dataset.panel}`;
    tab.setAttribute("aria-controls", tab.dataset.panel);
    panels[i].setAttribute("role", "tabpanel");
    panels[i].setAttribute("aria-labelledby", tab.id);
    tab.addEventListener("click", () => select(i, false));
    tab.addEventListener("keydown", (event) => {
      const moves = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 };
      if (!(event.key in moves)) return;
      event.preventDefault();
      select((moves[event.key] + tabs.length) % tabs.length, true);
    });
  });

  // Links to an old section anchor such as #review open that tab.
  const fromHash = () => {
    const index = tabs.findIndex((tab) => `#${tab.dataset.panel}` === location.hash);
    if (index === -1) return false;
    select(index, false);
    tablist.scrollIntoView();
    return true;
  };

  tablist.hidden = false;
  if (!fromHash()) select(0, false);
  window.addEventListener("hashchange", fromHash);
}
