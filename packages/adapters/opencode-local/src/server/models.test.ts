import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureOpenCodeModelConfiguredAndAvailable,
  inspectOpenCodeModelsOutput,
  listOpenCodeModels,
  parseOpenCodeModelsOutput,
  requireOpenCodeModelId,
  resetOpenCodeModelsCacheForTests,
} from "./models.js";

describe("openCode models", () => {
  afterEach(() => {
    delete process.env.PAPERCLIP_OPENCODE_COMMAND;
    delete process.env.OPENCODE_ALLOW_ALL_MODELS;
    resetOpenCodeModelsCacheForTests();
  });

  it("returns an empty list when discovery command is unavailable", async () => {
    process.env.PAPERCLIP_OPENCODE_COMMAND = "__paperclip_missing_opencode_command__";
    await expect(listOpenCodeModels()).resolves.toEqual([]);
  });

  it("rejects when model is missing", async () => {
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({ model: "" }),
    ).rejects.toThrow("OpenCode requires `adapterConfig.model`");
  });

  it("accepts a provider/model id without running discovery", () => {
    expect(requireOpenCodeModelId("openai/gpt-5.2-codex")).toBe("openai/gpt-5.2-codex");
  });

  it("rejects malformed provider/model ids before discovery", () => {
    expect(() => requireOpenCodeModelId("gpt-5.2-codex")).toThrow(
      "OpenCode requires `adapterConfig.model`",
    );
    expect(() => requireOpenCodeModelId("openai/")).toThrow(
      "OpenCode requires `adapterConfig.model`",
    );
  });

  it("rejects when discovery cannot run for configured model", async () => {
    process.env.PAPERCLIP_OPENCODE_COMMAND = "__paperclip_missing_opencode_command__";
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "openai/gpt-5",
      }),
    ).rejects.toThrow("Failed to start command");
  });

  it("skips the availability check when OPENCODE_ALLOW_ALL_MODELS is set in the run env", async () => {
    process.env.PAPERCLIP_OPENCODE_COMMAND = "__paperclip_missing_opencode_command__";
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "anthropic/tensorix/deepseek/deepseek-chat-v3.1",
        env: { OPENCODE_ALLOW_ALL_MODELS: "true" },
      }),
    ).resolves.toEqual([
      { id: "anthropic/tensorix/deepseek/deepseek-chat-v3.1", label: "anthropic/tensorix/deepseek/deepseek-chat-v3.1" },
    ]);
  });

  it("honours OPENCODE_ALLOW_ALL_MODELS from the process env", async () => {
    process.env.PAPERCLIP_OPENCODE_COMMAND = "__paperclip_missing_opencode_command__";
    process.env.OPENCODE_ALLOW_ALL_MODELS = "1";
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({ model: "anthropic/gateway/some-model" }),
    ).resolves.toEqual([{ id: "anthropic/gateway/some-model", label: "anthropic/gateway/some-model" }]);
  });

  it("still enforces provider/model format when OPENCODE_ALLOW_ALL_MODELS is set", async () => {
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "not-a-valid-id",
        env: { OPENCODE_ALLOW_ALL_MODELS: "true" },
      }),
    ).rejects.toThrow("OpenCode requires `adapterConfig.model`");
  });
});

/** Writes an executable shell script that stands in for an OpenCode binary. */
function stubOpenCodeBinary(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), "paperclip-opencode-stub-"));
  const path = join(dir, "opencode-stub");
  writeFileSync(path, `#!/bin/sh\n${script}\n`, "utf8");
  chmodSync(path, 0o755);
  return path;
}

/** Awaits a promise that must reject and returns the rejection as an Error. */
async function captureRejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
  throw new Error("expected the promise to reject, but it resolved");
}

describe("openCode models unusable-output diagnostics", () => {
  afterEach(() => {
    delete process.env.PAPERCLIP_OPENCODE_COMMAND;
    delete process.env.PAPERCLIP_OPENCODE_MODELS_RETRY_DELAY_MS;
    resetOpenCodeModelsCacheForTests();
  });

  it("names the resolved command and its version when exit 0 yields empty stdout", async () => {
    process.env.PAPERCLIP_OPENCODE_MODELS_RETRY_DELAY_MS = "10";
    const binary = stubOpenCodeBinary(
      'if [ "$1" = "--version" ]; then echo "opencode 2.0.12"; exit 0; fi\nexit 0',
    );

    const error = await captureRejection(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "opencode/big-pickle",
        command: binary,
      }),
    );

    expect(error.message).toContain(
      "exited 0 with empty stdout on 3 consecutive attempts using command",
    );
    expect(error.message).toContain(binary);
    expect(error.message).toContain("`--version` -> opencode 2.0.12");
  });

  it("points at the v1.x contract break instead of implying provider auth is broken", async () => {
    process.env.PAPERCLIP_OPENCODE_MODELS_RETRY_DELAY_MS = "10";
    const binary = stubOpenCodeBinary(
      'if [ "$1" = "--version" ]; then echo "opencode 2.0.12"; exit 0; fi\nexit 0',
    );

    const error = await captureRejection(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "opencode/big-pickle",
        command: binary,
      }),
    );

    expect(error.message).toContain("does not implement the v1.x `models` contract");
    expect(error.message).toContain("PAPERCLIP_OPENCODE_COMMAND");
    expect(error.message).not.toContain("verify provider auth");
  });

  it("reports unparsed output lines instead of silently discarding them", async () => {
    process.env.PAPERCLIP_OPENCODE_MODELS_RETRY_DELAY_MS = "10";
    // Output with no parsable id at all: models stays empty while the
    // unparsed lines are carried into the diagnostic.
    const binary = stubOpenCodeBinary(
      [
        'if [ "$1" = "--version" ]; then echo "opencode 1.18.16"; exit 0; fi',
        'echo "Available models:"',
        "exit 0",
      ].join("\n"),
    );

    const error = await captureRejection(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "openai/gpt-5",
        command: binary,
      }),
    );

    expect(error.message).toContain("1 line(s) with no `provider/model` id on 3 consecutive attempts");
    expect(error.message).toContain("Available models:");
  });

  it("still accepts a healthy model listing", async () => {
    const binary = stubOpenCodeBinary(
      [
        'if [ "$1" = "--version" ]; then echo "opencode 1.18.16"; exit 0; fi',
        'echo "opencode/big-pickle"',
        'echo "openai/gpt-5"',
        "exit 0",
      ].join("\n"),
    );

    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({ model: "opencode/big-pickle", command: binary }),
    ).resolves.toEqual([
      // discovery output is sorted by id (sortModels)
      { id: "openai/gpt-5", label: "openai/gpt-5" },
      { id: "opencode/big-pickle", label: "opencode/big-pickle" },
    ]);
  });
});

/**
 * Writes an executable shell script that stands in for an OpenCode binary and
 * appends one line per `models` invocation to a state file, so tests can
 * assert how many discovery attempts actually happened. `__COUNT__` in the
 * script is replaced with the state-file path.
 */
function stubOpenCodeBinaryWithAttemptLog(script: string): {
  binary: string;
  countPath: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "paperclip-opencode-stub-"));
  const countPath = join(dir, "models-attempts");
  const binary = join(dir, "opencode-stub");
  writeFileSync(binary, `#!/bin/sh\n${script.replace(/__COUNT__/g, countPath)}\n`, "utf8");
  chmodSync(binary, 0o755);
  return { binary, countPath };
}

function readAttemptLog(countPath: string): string[] {
  try {
    return readFileSync(countPath, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

describe("openCode models transient-empty retry", () => {
  afterEach(() => {
    delete process.env.PAPERCLIP_OPENCODE_COMMAND;
    delete process.env.PAPERCLIP_OPENCODE_MODELS_RETRY_DELAY_MS;
    resetOpenCodeModelsCacheForTests();
  });

  it("recovers when a later attempt returns a full listing", async () => {
    process.env.PAPERCLIP_OPENCODE_MODELS_RETRY_DELAY_MS = "10";
    const { binary, countPath } = stubOpenCodeBinaryWithAttemptLog(
      [
        'if [ "$1" = "--version" ]; then echo "opencode 2.0.12"; exit 0; fi',
        'echo x >> "__COUNT__"',
        'n=$(wc -l < "__COUNT__")',
        'if [ "$n" -ge 2 ]; then echo "opencode/big-pickle"; fi',
        "exit 0",
      ].join("\n"),
    );

    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({ model: "opencode/big-pickle", command: binary }),
    ).resolves.toEqual([{ id: "opencode/big-pickle", label: "opencode/big-pickle" }]);
    expect(readAttemptLog(countPath)).toHaveLength(2);
  });

  it("gives up after three consecutive empty attempts and says so", async () => {
    process.env.PAPERCLIP_OPENCODE_MODELS_RETRY_DELAY_MS = "10";
    const { binary, countPath } = stubOpenCodeBinaryWithAttemptLog(
      [
        'if [ "$1" = "--version" ]; then echo "opencode 2.0.12"; exit 0; fi',
        'echo x >> "__COUNT__"',
        "exit 0",
      ].join("\n"),
    );

    const error = await captureRejection(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "opencode/big-pickle",
        command: binary,
      }),
    );

    expect(error.message).toContain("on 3 consecutive attempts");
    expect(readAttemptLog(countPath)).toHaveLength(3);
  });

  it("does not retry when the command exits non-zero", async () => {
    process.env.PAPERCLIP_OPENCODE_MODELS_RETRY_DELAY_MS = "10";
    const { binary, countPath } = stubOpenCodeBinaryWithAttemptLog(
      [
        'if [ "$1" = "--version" ]; then echo "opencode 2.0.12"; exit 0; fi',
        'echo x >> "__COUNT__"',
        'echo "boom" >&2',
        "exit 7",
      ].join("\n"),
    );

    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({ model: "opencode/big-pickle", command: binary }),
    ).rejects.toThrow("`opencode models` failed: boom");
    expect(readAttemptLog(countPath)).toHaveLength(1);
  });
});

describe("inspectOpenCodeModelsOutput", () => {
  it("returns parsed models alongside the lines it skipped", () => {
    const result = inspectOpenCodeModelsOutput("Available models:\nopenai/gpt-5\nnot-an-id\n");
    expect(result.models).toEqual([{ id: "openai/gpt-5", label: "openai/gpt-5" }]);
    expect(result.unparsedLines).toEqual(["Available models:", "not-an-id"]);
  });

  it("treats a leading slash as unparsed rather than an empty provider", () => {
    const result = inspectOpenCodeModelsOutput("/leading-slash\n/model\n");
    expect(result.models).toEqual([]);
    expect(result.unparsedLines).toEqual(["/leading-slash", "/model"]);
  });

  it("parses ids with extra path segments (anthropic/tensorix/deepseek/...)", () => {
    expect(parseOpenCodeModelsOutput("anthropic/tensorix/deepseek/deepseek-chat\n")).toEqual([
      { id: "anthropic/tensorix/deepseek/deepseek-chat", label: "anthropic/tensorix/deepseek/deepseek-chat" },
    ]);
  });

  it("reports no unparsed lines for empty stdout", () => {
    const result = inspectOpenCodeModelsOutput("");
    expect(result.models).toEqual([]);
    expect(result.unparsedLines).toEqual([]);
  });
});
