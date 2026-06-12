// If already logged in, skip the login page.
fetch("/auth/me").then((r) => {
  if (r.ok) location.href = "/";
});

document.getElementById("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const username = document.getElementById("u").value.trim();
  const password = document.getElementById("p").value;
  const msg = document.getElementById("msg");
  msg.textContent = "";
  try {
    const res = await fetch("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (res.ok) {
      location.href = "/";
    } else {
      const d = await res.json().catch(() => ({}));
      msg.textContent = d.error || "Connexion impossible";
    }
  } catch {
    msg.textContent = "Serveur injoignable";
  }
});
