/* Shared auth guard + header chip. Include on every authenticated page,
   BEFORE the page's own script. Redirects to /login.html if not authenticated. */
(function () {
  window.logout = async function () {
    await fetch("/auth/logout", { method: "POST" }).catch(() => {});
    location.href = "/login.html";
  };

  window.AUTH_READY = fetch("/auth/me")
    .then((res) => {
      if (res.status === 401) {
        location.href = "/login.html";
        return null;
      }
      return res.json();
    })
    .then((me) => {
      if (!me) return null;
      window.CURRENT_USER = me;
      const isAdmin = me.role === "ADMIN";

      // Admin-only nav links / sections.
      document.querySelectorAll("[data-admin]").forEach((el) => {
        if (!isAdmin) el.style.display = "none";
      });

      // Pages that require admin redirect non-admins away.
      if (document.body.hasAttribute("data-require-admin") && !isAdmin) {
        location.href = "/";
        return null;
      }

      // Header user chip (replaces the old API-key bar).
      const chip = document.getElementById("userChip");
      if (chip) {
        const label =
          me.type === "apikey" ? "machine (clé API)" : `${me.username} · ${me.role === "ADMIN" ? "Admin" : "VA"}`;
        chip.innerHTML =
          `<span style="font-size:13px;color:#8b95a7">${label}</span>` +
          `<button onclick="logout()" style="padding:6px 10px;border-radius:8px;border:1px solid #252b38;background:#1d2330;color:#e6e9ef;cursor:pointer;font:inherit;font-size:12px">Déconnexion</button>`;
      }
      return me;
    });
})();
