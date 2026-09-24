// Copy buttons stay hidden without JavaScript or clipboard access.
if (navigator.clipboard) {
  for (const button of document.querySelectorAll("button[data-copy]")) {
    button.hidden = false;
    let reset;
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(button.dataset.copy);
        button.textContent = "Copied";
        button.dataset.state = "copied";
      } catch {
        button.textContent = "Copy failed";
      }
      clearTimeout(reset);
      reset = setTimeout(() => {
        button.textContent = "Copy";
        delete button.dataset.state;
      }, 1800);
    });
  }
}
