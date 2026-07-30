import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const buildDirectory = path.join(projectRoot, "dist");

if (path.dirname(buildDirectory) !== projectRoot || path.basename(buildDirectory) !== "dist") {
  throw new Error(`Refusing to clean unexpected path: ${buildDirectory}`);
}

fs.rmSync(buildDirectory, { recursive: true, force: true });
