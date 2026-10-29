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

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider>
      <AuthProvider>
        <ToastHost>
          <App />
        </ToastHost>
      </AuthProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
