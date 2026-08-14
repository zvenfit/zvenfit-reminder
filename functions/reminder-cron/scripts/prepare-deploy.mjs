import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const distDir = join(process.cwd(), "dist");
const runtimePackageDir = join(process.cwd(), "../../infra/function-runtime");
mkdirSync(distDir, { recursive: true });
rmSync(join(distDir, "node_modules"), { recursive: true, force: true });
copyFileSync(join(runtimePackageDir, "package.json"), join(distDir, "package.json"));
copyFileSync(join(runtimePackageDir, "package-lock.json"), join(distDir, "package-lock.json"));
