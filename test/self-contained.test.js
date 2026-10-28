import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function runtimeFiles() {
  const sourceDirectory = join(repositoryRoot, "src");
  return [
    join(repositoryRoot, "start.js"),
    ...readdirSync(sourceDirectory)
      .filter((name) => name.endsWith(".js"))
      .map((name) => join(sourceDirectory, name)),
  ];
}

test("runtime modules do not import Fontra's internal module paths", () => {
  // Fontra's built client is a webpack bundle and does not serve the modules
  // that the `fontra/` import map points at. Importing them from a plugin
  // produces a 404 that the browser reports as a disallowed MIME type.
  const offenders = [];

  for (const file of runtimeFiles()) {
    const contents = readFileSync(file, "utf8");
    if (/from\s+["']fontra\//.test(contents)) {
      offenders.push(file.slice(repositoryRoot.length + 1));
    }
  }

  assert.deepEqual(offenders, []);
});
