import { spawnSync } from "node:child_process";

type RunCheck = (script: string) => void;

/** No skip flag: both the npm build and direct build entrypoint use this gate. */
export function runReleaseChecks(run: RunCheck = runNpmCheck): void {
  run("check");
  run("test:critical");
}

function runNpmCheck(script: string): void {
  const result = spawnSync("npm", ["run", script], {
    stdio: "inherit",
    env: script === "test:critical"
      ? { ...process.env, NODE_ENV: "test" }
      : process.env,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Release blocked: ${script} failed`, { cause: result.error });
  }
}