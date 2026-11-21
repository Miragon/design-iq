import "./index.css";

import { createRoot } from "react-dom/client";

import type { BelugaApi } from "../core/ipc.ts";
import { App } from "./app.tsx";

declare global {
  interface Window {
    beluga: BelugaApi;
  }
}

createRoot(document.getElementById("root") as HTMLElement).render(<App />);
