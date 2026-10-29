// "Chat from the city" card: lets a signed-in Kick user post in partner chats from the FiveM Kick hub.
(function () {
  const card = document.getElementById("city-chat-card");
  if (!card) return;
  const stateEl = document.getElementById("city-chat-state");
  const toggle = document.getElementById("city-chat-toggle");
  const codeBox = document.getElementById("city-chat-code-box");
  const codeEl = document.getElementById("city-chat-code");
  const status = document.getElementById("city-chat-status");
  let enabled = false;

  function note(text, type) {
    status.textContent = text || "";
    status.className = "only-pixels-note" + (type ? " " + type : "");
  }

  function render(data) {
    enabled = Boolean(data.enabled);
    card.hidden = false;
    toggle.textContent = enabled ? "Turn off" : "Turn on";
    toggle.className = enabled ? "btn btn-secondary" : "btn btn-kick";
    codeBox.hidden = !(enabled && data.linkCode);
    codeEl.textContent = data.linkCode || "------";
    if (!enabled) stateEl.textContent = "Off. Turn it on to get your link code.";
    else if (data.gameLinked) stateEl.textContent = "On, and linked to your game account. You can chat from the hub.";
    else stateEl.textContent = "On. Now type the code below in the city to link your game account.";
    if (data.canChat === false && !enabled) note("Sign out and sign in with Kick again first, so Kick lets us send chat for you.", "err");
  }

  async function load() {
    try {
      const r = await fetch("/api/rewards/city-chat", { credentials: "same-origin" });
      if (!r.ok) return;                       // not signed in with Kick: card stays hidden
      render(await r.json());
    } catch (_) { /* offline */ }
  }

  toggle.addEventListener("click", async () => {
    toggle.disabled = true;
    note("");
    try {
      const r = await fetch("/api/rewards/city-chat", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !enabled }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || "Could not save");
      render({ ...data, canChat: true });
      note(data.enabled ? "Turned on." : "Turned off. The city can't send chat for you anymore.", "ok");
    } catch (error) {
      note(error.message, "err");
    } finally {
      toggle.disabled = false;
    }
  });

  load();
})();
