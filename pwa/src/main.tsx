import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { initAuth } from "./lib/api";
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
