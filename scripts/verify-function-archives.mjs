import { statSync } from "node:fs";
import { basename, resolve } from "node:path";

// `yc serverless function version create --source-path` rejects archives above
// 3.5 MB. Keep a small buffer below that API limit.
const maxArchiveBytes = 3_400_000;
const archiveArgs = process.argv.slice(2);
if (archiveArgs.length === 0) {
  throw new Error("Pass at least one function archive path");
}

for (const archiveArg of archiveArgs) {
  const archivePath = resolve(archiveArg);
  const size = statSync(archivePath).size;
  if (size > maxArchiveBytes) {
    throw new Error(
      `${basename(archivePath)} is ${size} bytes; maximum is ${maxArchiveBytes} bytes`,
    );
  }
  console.log(`Verified ${basename(archivePath)}: ${size} bytes`);
}
