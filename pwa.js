const RELOAD_GUARD_KEY = "guitar_tuner_pwa_reload_guard";

if ("serviceWorker" in navigator) {
  const hadControllerOnLoad = Boolean(navigator.serviceWorker.controller);

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadControllerOnLoad) {
      return;
    }
    if (sessionStorage.getItem(RELOAD_GUARD_KEY) === "1") {
      return;
    }
    sessionStorage.setItem(RELOAD_GUARD_KEY, "1");
    window.location.reload();
  });

  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js").catch((err) => {
      console.warn("Service worker registration failed", err);
    });
  });
}
