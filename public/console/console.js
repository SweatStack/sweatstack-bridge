// The console's one script, loaded in <head>. Everything here is a convenience: the console works without it.
(() => {
  const root = document.documentElement;

  // The theme: the system's until the owner chooses, then theirs, remembered in this browser only. Set before
  // the page draws, so it never shows the other theme first.
  try {
    const saved = localStorage.getItem("theme");
    if (saved === "light" || saved === "dark") root.dataset.theme = saved;
  } catch {
    // Storage can be blocked. The system's theme is fine.
  }
  const isDark = () => (root.dataset.theme ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")) === "dark";

  document.addEventListener("DOMContentLoaded", () => {
    const toggle = document.querySelector("[data-theme-toggle]");
    if (toggle !== null) {
      const label = () => toggle.setAttribute("aria-label", isDark() ? "Switch to light mode" : "Switch to dark mode");
      toggle.hidden = false;
      label();
      toggle.addEventListener("click", () => {
        root.dataset.theme = isDark() ? "light" : "dark";
        try {
          localStorage.setItem("theme", root.dataset.theme);
        } catch {
          // Kept for this page only.
        }
        label();
      });
    }

    // The walk's start form carries the browser's time zone, for the calendar day of a daily value. Without
    // it, UTC, which at worst makes a night's step wait for one more day.
    for (const field of document.querySelectorAll("[data-time-zone]")) {
      try {
        field.value = Intl.DateTimeFormat().resolvedOptions().timeZone;
      } catch {
        // UTC stays.
      }
    }

    // Copy buttons, next to a read-only field that holds the value. Without them, the field can be selected.
    for (const button of document.querySelectorAll("[data-copy]")) {
      const field = button.parentElement?.querySelector("input");
      if (field === null || field === undefined) continue;
      button.hidden = false;
      button.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(field.value);
          button.textContent = "Copied";
        } catch {
          field.select();
          button.textContent = "Press Ctrl+C";
        }
        setTimeout(() => (button.textContent = "Copy"), 1500);
      });
    }
  });
})();
