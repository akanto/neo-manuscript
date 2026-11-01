import type { TexDocument } from "../../core/document.ts";
import type { HostBridge } from "../../core/host-api.ts";
import { startView } from "../../view/main.ts";
import { miradorProject } from "./project.ts";

declare global {
  interface Window {
    /** The bridge Mirador puts in the view's frame. */
    mirador: HostBridge<TexDocument>;
  }
}

// Mirador's canvas tells the frame its theme.
addEventListener("message", (event) => {
  const data = event.data as { source?: string; kind?: string; theme?: string } | null;
  if (data?.source === "mirador-canvas" && data.kind === "theme" && (data.theme === "dark" || data.theme === "light")) document.documentElement.style.colorScheme = data.theme;
});

// Mirador's bridge, as it is, with the project's files beside it: its methods stay on it, as they may need it.
const mirador = window.mirador;
startView(Object.assign(Object.create(mirador) as typeof mirador, { project: miradorProject(mirador) }));
