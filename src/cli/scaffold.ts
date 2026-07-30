import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function templateRoot(): string {
  let current = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    const candidate = path.join(current, "templates", "review-council");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) throw new Error("bundled review-council template not found");
    current = parent;
  }
}

export function scaffoldWorkflow(destination: string): string {
  const target = path.resolve(destination);
  if (fs.existsSync(target) && fs.readdirSync(target).length > 0) {
    throw new Error(`destination is not empty: ${target}`);
  }
  fs.mkdirSync(target, { recursive: true });
  fs.cpSync(templateRoot(), target, { recursive: true, errorOnExist: true, force: false });
  return target;
}
