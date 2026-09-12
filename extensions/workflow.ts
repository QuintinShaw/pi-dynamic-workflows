// Pi supplies this require through its TypeScript loader. Keep the compiled
// graph synchronous: an async ESM re-export can take jiti's native-import
// shortcut and bypass the host's SDK aliases/virtual modules.
const extension = require("../dist/pi-extension.js") as typeof import("../dist/pi-extension.js");
export const sessionFileCwd = extension.sessionFileCwd;
export default extension.default;
