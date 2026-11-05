const UPDATE_DISMISS_KEY = "guitar_tuner_pwa_update_dismiss";

const updateBar = document.getElementById("pwa-update");
const updateBtn = document.getElementById("pwa-update-btn");
const updateDismiss = document.getElementById("pwa-update-dismiss");

/** @type {ServiceWorkerRegistration | null} */
let registration = null;
/** Reload only after the user taps Reload — not on silent "next open" activation. */
let userInitiatedUpdate = false;
let refreshing = false;

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void registerServiceWorker();
  });

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!userInitiatedUpdate || refreshing) {
      return;
    }
    refreshing = true;
    window.location.reload();
  });
}

function showUpdateBarIfNeeded() {
  if (!(updateBar instanceof HTMLElement)) {
    return;
  }
  if (sessionStorage.getItem(UPDATE_DISMISS_KEY) === "1") {
    return;
  }
  if (registration?.waiting && navigator.serviceWorker.controller) {
    updateBar.hidden = false;
  }
}

async function registerServiceWorker() {
  try {
    registration = await navigator.serviceWorker.register("/sw.js");

    registration.addEventListener("updatefound", () => {
      const installing = registration?.installing;
      if (!installing) {
        return;
      }
      installing.addEventListener("statechange", () => {
        if (installing.state === "installed" && navigator.serviceWorker.controller) {
          sessionStorage.removeItem(UPDATE_DISMISS_KEY);
          showUpdateBarIfNeeded();
        }
      });
    });

    showUpdateBarIfNeeded();
  } catch (err) {
    console.warn("Service worker registration failed", err);
  }
}

if (updateBtn instanceof HTMLButtonElement) {
  updateBtn.addEventListener("click", () => {
    userInitiatedUpdate = true;
    const waiting = registration?.waiting;
    if (waiting) {
      waiting.postMessage({ type: "SKIP_WAITING" });
      return;
    }
    window.location.reload();
  });
}

if (updateDismiss instanceof HTMLButtonElement && updateBar instanceof HTMLElement) {
  updateDismiss.addEventListener("click", () => {
    updateBar.hidden = true;
    sessionStorage.setItem(UPDATE_DISMISS_KEY, "1");
  });
}
