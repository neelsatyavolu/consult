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
