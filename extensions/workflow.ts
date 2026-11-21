// Resolve the host SDK through Pi's loader, but load our compiled ESM graph
// with import semantics. Requiring the graph makes import-only SDK subpaths
// fall through the host's prefix aliases as invalid file-system paths.
const host = await import("@earendil-works/pi-coding-agent");
const extension = await import("../dist/pi-extension.js");
extension.installHostCreateAgentSession(host.createAgentSession, host);
extension.installHostSessionCapture(host.AgentSession);
export const sessionFileCwd = extension.sessionFileCwd;
const renderer = extension.createWorkflowResultRenderer(host.keyHint, host.getMarkdownTheme);
export default (pi: Parameters<typeof extension.default>[0]) => extension.default(pi, renderer);
