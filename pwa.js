const RELOAD_GUARD_KEY = "guitar_tuner_pwa_reload_guard";

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (sessionStorage.getItem(RELOAD_GUARD_KEY) === "1") {
      return;
    }
    sessionStorage.setItem(RELOAD_GUARD_KEY, "1");
    window.location.reload();
  });

  window.addEventListener("load", () => {
    sessionStorage.removeItem(RELOAD_GUARD_KEY);
    void navigator.serviceWorker.register("/sw.js").catch((err) => {
      console.warn("Service worker registration failed", err);
    });
  });
}
