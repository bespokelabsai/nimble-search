import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { walkRepoFiles } from "../src/repo/walker.js";

async function makeTempRepo(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "nimble-walker-test-"));
}

async function writeFixture(root: string, rel: string, content: string): Promise<void> {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
}

test("walkRepoFiles honors .gitignore, nested .gitignore, .nimbleignore, and skips lockfiles/binaries", async () => {
  const root = await makeTempRepo();
  try {
    await writeFixture(root, ".gitignore", "ignored-dir/\n*.log\n");
    await writeFixture(root, ".nimbleignore", "secret.txt\n");
    await writeFixture(root, "src/app.ts", "export const ok = true;\n");
    await writeFixture(root, "src/debug.log", "noisy log\n");
    await writeFixture(root, "src/.gitignore", "local-only.ts\n");
    await writeFixture(root, "src/local-only.ts", "export const hidden = 1;\n");
    await writeFixture(root, "ignored-dir/skip.ts", "export const skip = 1;\n");
    await writeFixture(root, "secret.txt", "top secret\n");
    await writeFixture(root, "package-lock.json", "{}\n");
    await writeFixture(root, "node_modules/pkg/index.js", "module.exports = 1;\n");
    await writeFixture(root, "assets/logo.png", "fake png bytes\n");
    await writeFixture(root, "README.md", "# Hello\n");

    const files = await walkRepoFiles({ rootDir: root });
    const rels = files.map((f) => f.relPath);

    assert.deepEqual(rels, ["README.md", "src/app.ts"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("walkRepoFiles filters by extension and subpath, and rejects escaping subpath", async () => {
  const root = await makeTempRepo();
  try {
    await writeFixture(root, "packages/api/routes.ts", "export const r = 1;\n");
    await writeFixture(root, "packages/api/README.md", "# API\n");
    await writeFixture(root, "packages/web/ui.tsx", "export const UI = () => null;\n");

    const apiTs = await walkRepoFiles({
      rootDir: root,
      subpath: "packages/api",
      extensions: [".ts"],
    });
    assert.deepEqual(
      apiTs.map((f) => f.relPath),
      ["packages/api/routes.ts"]
    );

    await assert.rejects(
      () => walkRepoFiles({ rootDir: root, subpath: "../outside" }),
      /escapes repository root/
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
