const UPDATE_DISMISS_KEY = "guitar_tuner_pwa_update_dismiss";

const updateBar = document.getElementById("pwa-update");
const updateBtn = document.getElementById("pwa-update-btn");
const updateDismiss = document.getElementById("pwa-update-dismiss");

/** @type {ServiceWorkerRegistration | null} */
let registration = null;
let refreshing = false;

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void registerServiceWorker();
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      void refreshRegistrationAndBar();
    }
  });
}

function hideUpdateBar() {
  if (updateBar instanceof HTMLElement) {
    updateBar.hidden = true;
  }
  if (updateBtn instanceof HTMLButtonElement) {
    updateBtn.disabled = false;
    updateBtn.textContent = "Reload";
  }
}

function showUpdateBarIfNeeded() {
  if (!(updateBar instanceof HTMLElement)) {
    return;
  }
  if (sessionStorage.getItem(UPDATE_DISMISS_KEY) === "1") {
    hideUpdateBar();
    return;
  }
  if (registration?.waiting && navigator.serviceWorker.controller) {
    updateBar.hidden = false;
    return;
  }
  hideUpdateBar();
}

async function refreshRegistrationAndBar() {
  try {
    registration = await navigator.serviceWorker.getRegistration();
  } catch {
    registration = null;
  }
  showUpdateBarIfNeeded();
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
        if (installing.state === "activated") {
          hideUpdateBar();
        }
      });
    });

    if (registration.waiting) {
      registration.waiting.addEventListener("statechange", () => {
        if (registration?.waiting?.state === "activated") {
          hideUpdateBar();
        }
      });
    }

    showUpdateBarIfNeeded();
  } catch (err) {
    console.warn("Service worker registration failed", err);
  }
}

async function applyWaitingUpdate() {
  if (refreshing) {
    return;
  }

  if (updateBtn instanceof HTMLButtonElement) {
    updateBtn.disabled = true;
    updateBtn.textContent = "Reloading…";
  }

  const reg = registration ?? (await navigator.serviceWorker.getRegistration());
  const waiting = reg?.waiting;

  if (!waiting) {
    hideUpdateBar();
    refreshing = true;
    window.location.reload();
    return;
  }

  const finishReload = () => {
    if (refreshing) {
      return;
    }
    refreshing = true;
    sessionStorage.removeItem(UPDATE_DISMISS_KEY);
    hideUpdateBar();
    window.location.reload();
  };

  const onStateChange = () => {
    if (waiting.state === "activated") {
      waiting.removeEventListener("statechange", onStateChange);
      finishReload();
    }
  };
  waiting.addEventListener("statechange", onStateChange);

  const onControllerChange = () => {
    navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
    finishReload();
  };
  navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);

  try {
    waiting.postMessage({ type: "SKIP_WAITING" });
  } catch (err) {
    console.warn("skipWaiting message failed", err);
  }

  window.setTimeout(() => {
    finishReload();
  }, 1200);
}

if (updateBtn instanceof HTMLButtonElement) {
  updateBtn.addEventListener("click", () => {
    void applyWaitingUpdate();
  });
}

if (updateDismiss instanceof HTMLButtonElement) {
  updateDismiss.addEventListener("click", () => {
    hideUpdateBar();
    sessionStorage.setItem(UPDATE_DISMISS_KEY, "1");
  });
}
