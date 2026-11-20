import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";

test("MCP stdio server responds to initialize, tools/list, and scan_repo tool call", async () => {
  const cliPath = path.resolve(process.cwd(), "dist", "cli.js");
  const child = spawn(process.execPath, [cliPath, "mcp", "--dir", process.cwd()], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  const responses: Array<Record<string, unknown>> = [];
  let buffer = "";

  const waitForId = (id: number, timeoutMs = 5000): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Timed out waiting for JSON-RPC id=${id}`)),
        timeoutMs
      );
      const check = () => {
        const found = responses.find((r) => r.id === id);
        if (found) {
          clearTimeout(timer);
          resolve(found);
          return true;
        }
        return false;
      };
      if (check()) return;
      const onData = () => {
        if (check()) {
          child.stdout.off("data", onData);
        }
      };
      child.stdout.on("data", onData);
    });

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let nlIdx = buffer.indexOf("\n");
    while (nlIdx !== -1) {
      const line = buffer.slice(0, nlIdx).trim();
      buffer = buffer.slice(nlIdx + 1);
      if (line) {
        responses.push(JSON.parse(line) as Record<string, unknown>);
      }
      nlIdx = buffer.indexOf("\n");
    }
  });

  const send = (msg: Record<string, unknown>) => {
    child.stdin.write(`${JSON.stringify(msg)}\n`);
  };

  try {
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-client", version: "0.1.0" },
      },
    });
    const initRes = await waitForId(1);
    assert.ok(initRes.result);

    send({ jsonrpc: "2.0", method: "notifications/initialized" });

    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const listRes = (await waitForId(2)) as {
      result: { tools: Array<{ name: string }> };
    };
    const names = listRes.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["scan_repo", "search_files"]);

    send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "scan_repo", arguments: { directory: process.cwd() } },
    });
    const callRes = (await waitForId(3)) as {
      result: { content: Array<{ type: string; text: string }> };
    };
    assert.match(callRes.result.content[0]?.text ?? "", /Searchable files:/);
  } finally {
    child.kill();
  }
});
