// The Settings view's model: reading a typed port, what a port change will do, and the note shown
// when the server runs on other ports than the saved ones (a development run's overrides).
import type { SettingsView } from "../../server/settings/index.js";

export type PortRole = "ea" | "http";

export const PORT_LABELS: Record<PortRole, string> = { ea: "EA port", http: "Dashboard port" };
const IN_SENTENCE: Record<PortRole, string> = { ea: "EA port", http: "dashboard port" };

/** The typed port, or why it cannot be used (the server checks again, and whether it is free). */
export function parsePort(text: string, role: PortRole, view: SettingsView): { port: number } | { error: string } {
  const trimmed = text.trim();
  if (!trimmed) return { error: "Type a port number." };
  const port = Number(trimmed);
  if (!/^\d+$/.test(trimmed) || port < 1024 || port > 65535) return { error: "Use a whole number from 1024 to 65535." };
  const other: PortRole = role === "ea" ? "http" : "ea";
  if (port === view.ports[other]) return { error: `The ${IN_SENTENCE[other]} already uses ${port}.` };
  if (port === view.ports[role]) return { error: `The ${IN_SENTENCE[role]} is already ${port}.` };
  return { port };
}

/** The confirmation for a port change: what restarts, and what the user must do in MetaTrader afterwards. */
export function portChange(role: PortRole, port: number, managedTerminals: number): { title: string; body: string; confirm: string } {
  const title = `Change the ${IN_SENTENCE[role]} to ${port}?`;
  const confirm = `Restart on port ${port}`;
  if (role === "http") {
    return { title, confirm, body: "QuoteBridge restarts on the new port and this window reconnects by itself. Nothing changes in MetaTrader." };
  }
  const terminals =
    managedTerminals === 0 ? "" : ` The QuoteBridge template in your ${managedTerminals === 1 ? "managed terminal" : `${managedTerminals} managed terminals`} is updated.`;
  return {
    title,
    confirm,
    body: `QuoteBridge restarts on the new port.${terminals} Charts already running the EA keep the old port and stop sending quotes: apply the QuoteBridge template to each chart again.`,
  };
}

/** Null while the server runs on the saved ports. */
export function portsNote(view: SettingsView): string | null {
  const { ports, portsInUse } = view;
  if (ports.ea === portsInUse.ea && ports.http === portsInUse.http) return null;
  return `This run listens on EA port ${portsInUse.ea} and dashboard port ${portsInUse.http}: a development run's port overrides win over the saved ports.`;
}
