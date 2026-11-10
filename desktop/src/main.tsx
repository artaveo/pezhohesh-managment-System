import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/vazirmatn/400.css";
import "@fontsource/vazirmatn/600.css";
import "@fontsource/vazirmatn/800.css";
import "./styles.css";
import { ThemeProvider } from "./theme/ThemeProvider";
import { AuthProvider } from "./auth/AuthProvider";
import App from "./App";
import { ToastHost } from "./components/Toast";
import { ErrorBoundary, watchErrors } from "./components/ErrorBoundary";

watchErrors();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ThemeProvider>
        <AuthProvider>
          <ToastHost>
            <App />
          </ToastHost>
        </AuthProvider>
      </ThemeProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
