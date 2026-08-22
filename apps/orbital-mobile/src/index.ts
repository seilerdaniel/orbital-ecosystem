/**
 * Placeholder entry for the Orbital mobile companion.
 *
 * The runtime shell (React Native / Expo) lands in a dedicated change;
 * for now this package keeps the workspace wired and builds the shared
 * app metadata consumed by tooling and the dock.
 */

export const APP_INFO = {
  name: "Orbital Mobile",
  version: "0.1.0",
  description: "Mobile companion for the Orbital ecosystem",
  platform: "placeholder" as const
} as const;

export type AppInfo = typeof APP_INFO;
