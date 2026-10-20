import { execFileSync } from "node:child_process";
for (const cwd of [
  ".",
  ...["api", "publicRead", "platformCallback", "maintenance"].map(
    (n) => "cloudfunctions/" + n,
  ),
]) {
  console.log("Audit " + cwd);
  execFileSync("npm", ["audit", "--audit-level=moderate"], {
    cwd,
    stdio: "inherit",
  });
}
