import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

// Mock accounts and data never replace a developer's live cloud build/config.
const root = process.cwd();
const stage = fs.mkdtempSync(path.join(os.tmpdir(), "squiddy-tests-"));
try {
  for (const name of [
    "src",
    "domain",
    "shared",
    "cloud",
    "cloudfunctions",
    "scripts",
    "tests",
  ])
    fs.cpSync(path.join(root, name), path.join(stage, name), {
      recursive: true,
      filter: (source) => path.basename(source) !== "node_modules",
    });
  for (const name of ["tsconfig.json", "project.config.example.json"])
    fs.copyFileSync(path.join(root, name), path.join(stage, name));
  fs.symlinkSync(
    path.join(root, "node_modules"),
    path.join(stage, "node_modules"),
    "dir",
  );
  for (const name of ["api", "publicRead", "platformCallback", "maintenance"])
    fs.symlinkSync(
      path.join(root, "cloudfunctions", name, "node_modules"),
      path.join(stage, "cloudfunctions", name, "node_modules"),
      "dir",
    );
  execFileSync(process.execPath, ["scripts/build.mjs"], {
    cwd: stage,
    stdio: "inherit",
  });
  const tests = fs
    .readdirSync(path.join(stage, "tests"))
    .filter((name) => name.endsWith(".test.cjs"))
    .map((name) => path.join("tests", name));
  execFileSync(process.execPath, ["--test", ...tests], {
    cwd: stage,
    stdio: "inherit",
  });
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}
