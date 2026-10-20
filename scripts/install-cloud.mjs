import { execFileSync } from "node:child_process";
for (const name of ["api", "publicRead", "platformCallback", "maintenance"])
  execFileSync("npm", ["ci", "--ignore-scripts"], {
    cwd: "cloudfunctions/" + name,
    stdio: "inherit",
  });
