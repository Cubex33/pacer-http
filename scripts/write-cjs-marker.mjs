// Marks the CommonJS build directory so Node treats dist/cjs/*.js as CommonJS
// while the package root stays "type": "module" (dual ESM/CJS package).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const target = join(root, "dist", "cjs", "package.json");
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, '{ "type": "commonjs" }\n');
console.log("wrote", target);
