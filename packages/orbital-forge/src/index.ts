/**
 * @orbital/forge — content pipeline for the Orbital ecosystem.
 *
 * Library surface (this barrel): the release-notes/demo generation engine.
 * The bus-connected render service lives behind the `./service` subpath so
 * library consumers do not need the WebSocket transport.
 */

export {
  Forge,
  type ForgeScaffoldOptions,
  type ForgeTemplate,
  type GeneratedFile
} from "./scaffold.js";

export {
  buildDemoStoryboard,
  collectCommits,
  compileReleaseNotes,
  renderContentPackage,
  renderStoryboardMarkdown,
  toOpenMontageProject,
  type ConventionalCommit,
  type DemoStoryboard,
  type GeneratedFileAbs,
  type OpenMontageProject,
  type RenderOptions,
  type RenderResult,
  type Scene
} from "./forge.js";
