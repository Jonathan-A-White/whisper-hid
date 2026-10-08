import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import { initAuth } from "./lib/api";
import { installPreloadErrorReload, startAppUpdates } from "./lib/appUpdate";
import { ErrorBoundary } from "./components/ErrorBoundary";
import App from "./App";
import "./index.css";

initAuth();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
);

installPreloadErrorReload({
  target: window,
  reload: () => window.location.reload(),
  storage: sessionStorage,
});

// vite.config.ts: registerType 'prompt', so a new build waits for his tap on the banner. The
// registration goes to the update logic, which shows the banner, sends SKIP_WAITING on the tap,
// reloads once, and looks for a new build (src/lib/appUpdate.ts).
registerSW({
  immediate: true,
  onRegisteredSW(_url, registration) {
    if (registration)
      startAppUpdates({
        container: navigator.serviceWorker,
        registration,
        reload: () => window.location.reload(),
      });
  },
});
