import { gzipSync } from "node:zlib";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const clientDir = fileURLToPath(new URL("../dist/client/", import.meta.url));
const manifest = JSON.parse(readFileSync(join(clientDir, "client-manifest.json"), "utf8"));
const chunks = [...new Map(Object.values(manifest)
  .filter((entry) => entry && typeof entry === "object" && typeof entry.file === "string" && entry.file.endsWith(".js"))
  .map((entry) => [entry.file, entry])).values()];
const limits = {
  entryRaw: 310_000,
  entryGzip: 100_000,
  routeRaw: 220_000,
  routeGzip: 70_000,
  entryCssRaw: 380_000,
  entryCssGzip: 60_000
};
const failures = [];
for (const chunk of chunks) {
  const name = chunk.file;
  const path = join(clientDir, name);
  const raw = statSync(path).size;
  const gzip = gzipSync(readFileSync(path)).length;
  const isEntry = chunk.isEntry === true;
  const rawLimit = isEntry ? limits.entryRaw : limits.routeRaw;
  const gzipLimit = isEntry ? limits.entryGzip : limits.routeGzip;
  if (raw > rawLimit) failures.push(`${name}: raw ${raw} > ${rawLimit}`);
  if (gzip > gzipLimit) failures.push(`${name}: gzip ${gzip} > ${gzipLimit}`);
  console.log(`${name}\traw=${raw}\tgzip=${gzip}`);
}
if (!chunks.some((chunk) => chunk.isEntry === true)) failures.push("当前构建 manifest 中没有 entry chunk");
for (const cssFile of new Set(chunks.filter((chunk) => chunk.isEntry === true).flatMap((chunk) => chunk.css ?? []))) {
  const cssPath = join(clientDir, cssFile);
  const raw = statSync(cssPath).size;
  const gzip = gzipSync(readFileSync(cssPath)).length;
  if (raw > limits.entryCssRaw) failures.push(`${cssFile}: raw ${raw} > ${limits.entryCssRaw}`);
  if (gzip > limits.entryCssGzip) failures.push(`${cssFile}: gzip ${gzip} > ${limits.entryCssGzip}`);
  console.log(`${cssFile}\traw=${raw}\tgzip=${gzip}`);
}
if (failures.length) {
  console.error(`Bundle budget exceeded:\n${failures.join("\n")}`);
  process.exitCode = 1;
}
