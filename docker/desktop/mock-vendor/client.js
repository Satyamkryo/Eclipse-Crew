/* Independent synthetic site: no application session, model calls or external requests. */
for (const button of document.querySelectorAll("button[data-demo-action]")) {
  button.addEventListener("click", async () => {
    const controls = document.querySelectorAll("button[data-demo-action]");
    const status = document.getElementById("demo-status");
    const error = document.getElementById("demo-error");
    controls.forEach((control) => { control.disabled = true; });
    error.hidden = true;
    status.textContent = "Updating demo…";
    try {
      const action = button.dataset.demoAction;
      const body = action === "reset" ? { action } : { action, layout: button.dataset.layout, month: new URL(location.href).searchParams.get("month") ?? "2026-10" };
      const response = await fetch("/__demo/control", { method: "POST", headers: {
        "Content-Type": "application/json", "X-Demo-CSRF": document.querySelector('meta[name="csrf-token"]').content,
      }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw Error("control_refused");
      const result = await response.json();
      location.assign(result.path);
    } catch {
      status.textContent = "";
      error.textContent = "Couldn't update the demo. Reload the page and try again.";
      error.hidden = false;
      controls.forEach((control) => { control.disabled = false; });
      button.focus();
    }
  });
}
