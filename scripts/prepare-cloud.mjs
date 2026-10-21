import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

// Prepare deployable Linux packages without modifying local test dependencies.
const root = path.resolve("artifacts/cloud-deploy/linux");
for (const name of ["api", "publicRead", "platformCallback", "maintenance"]) {
  const target = path.join(root, name);
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(path.resolve("cloudfunctions", name), target, {
    recursive: true,
    filter: (source) => path.basename(source) !== "node_modules",
  });
  execFileSync("npm", ["ci", "--ignore-scripts", "--os=linux", "--cpu=x64"], {
    cwd: target,
    stdio: "inherit",
  });
  for (const dependency of ["lodash.set", "lodash.unset"]) {
    if (
      !fs.lstatSync(path.join(target, "node_modules", dependency)).isDirectory()
    )
      throw new Error(`${name}: ${dependency} must be an ordinary directory`);
  }
  console.log(`Prepared ${name}: ${target}`);
}
console.log("Deploy these paths without --remote-npm-install.");
