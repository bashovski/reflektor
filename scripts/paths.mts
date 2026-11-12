// The repo's root, for the tools in scripts/. They always run compiled, from dist/tools/scripts/ (tsconfig.tools.json),
// three folders below the root.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
