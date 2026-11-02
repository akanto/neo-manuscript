import type { TexDocument } from "../../core/document.ts";
import { startView } from "../../view/main.ts";
import type { MiradorBridge } from "./api.ts";
import { miradorBridge } from "./project.ts";

declare global {
  interface Window {
    /** The bridge Mirador puts in the view's frame. */
    mirador: MiradorBridge<TexDocument>;
  }
}

// Mirador's canvas tells the frame its theme.
addEventListener("message", (event) => {
  const data = event.data as { source?: string; kind?: string; theme?: string } | null;
  if (data?.source === "mirador-canvas" && data.kind === "theme" && (data.theme === "dark" || data.theme === "light")) document.documentElement.style.colorScheme = data.theme;
});

startView(miradorBridge(window.mirador));
