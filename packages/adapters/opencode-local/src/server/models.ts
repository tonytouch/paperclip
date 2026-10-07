import { createHash } from "node:crypto";
import os from "node:os";
import type { AdapterModel } from "@paperclipai/adapter-utils";
import {
  asString,
  ensurePathInEnv,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import { isValidOpenCodeModelId } from "../index.js";

const MODELS_CACHE_TTL_MS = 60_000;
const MODELS_DISCOVERY_TIMEOUT_MS = 20_000;
const MODELS_VERSION_PROBE_TIMEOUT_MS = 5_000;
const MODELS_OUTPUT_SAMPLE_LINES = 5;
/**
 * `opencode models` on v2.x intermittently exits 0 with empty stdout (the
 * thin client races the background `opencode serve` daemon), so a single
 * empty result must not fail pre-flight. Retry a bounded number of times
 * with a short delay before treating the output as unusable.
 */
const MODELS_DISCOVERY_ATTEMPTS = 3;
const MODELS_DISCOVERY_RETRY_DELAY_MS = 1_500;

function resolveRetryDelayMs(): number {
  const raw = process.env.PAPERCLIP_OPENCODE_MODELS_RETRY_DELAY_MS;
  if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return MODELS_DISCOVERY_RETRY_DELAY_MS;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveOpenCodeCommand(input: unknown): string {
  const envOverride =
    typeof process.env.PAPERCLIP_OPENCODE_COMMAND === "string" &&
    process.env.PAPERCLIP_OPENCODE_COMMAND.trim().length > 0
      ? process.env.PAPERCLIP_OPENCODE_COMMAND.trim()
      : "opencode";
  return asString(input, envOverride);
}

const discoveryCache = new Map<string, { expiresAt: number; models: AdapterModel[] }>();
const VOLATILE_ENV_KEY_PREFIXES = ["PAPERCLIP_", "npm_", "NPM_"] as const;
const VOLATILE_ENV_KEY_EXACT = new Set(["PWD", "OLDPWD", "SHLVL", "_", "TERM_SESSION_ID", "HOME"]);

export function requireOpenCodeModelId(input: unknown): string {
  const model = asString(input, "").trim();
  if (!isValidOpenCodeModelId(model)) {
    throw new Error("OpenCode requires `adapterConfig.model` in provider/model format.");
  }
  return model;
}

function dedupeModels(models: AdapterModel[]): AdapterModel[] {
  const seen = new Set<string>();
  const deduped: AdapterModel[] = [];
  for (const model of models) {
    const id = model.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    deduped.push({ id, label: model.label.trim() || id });
  }
  return deduped;
}

function sortModels(models: AdapterModel[]): AdapterModel[] {
  return [...models].sort((a, b) =>
    a.id.localeCompare(b.id, "en", { numeric: true, sensitivity: "base" }),
  );
}

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function sampleOutputLines(lines: string[]): string {
  const shown = lines.slice(0, MODELS_OUTPUT_SAMPLE_LINES).join(" | ");
  return lines.length > MODELS_OUTPUT_SAMPLE_LINES ? `${shown} | ...` : shown;
}

/**
 * Best-effort `--version` probe for the resolved command. Only used on failure
 * paths so the diagnostic can name the binary that actually ran; a v1.x/v2.x
 * contract break is invisible from the command string alone.
 */
async function probeOpenCodeVersion(input: {
  command: string;
  cwd: string;
  env: Record<string, string>;
}): Promise<string> {
  try {
    const result = await runChildProcess(
      `opencode-version-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      input.command,
      ["--version"],
      {
        cwd: input.cwd,
        env: input.env,
        timeoutSec: MODELS_VERSION_PROBE_TIMEOUT_MS / 1000,
        graceSec: 1,
        onLog: async () => {},
      },
    );
    const version = firstNonEmptyLine(result.stdout) || firstNonEmptyLine(result.stderr);
    if (result.timedOut || (result.exitCode ?? 1) !== 0 || !version) return "unknown";
    return version;
  } catch {
    return "unknown";
  }
}

/**
 * Builds the actionable error for the two ways `opencode models` can fail to
 * yield usable ids. Both are fatal for model selection, and neither means
 * "provider auth is broken" — they mean the resolved CLI did not emit the
 * `provider/model` lines this parser needs.
 */
async function describeUnusableModelsOutput(input: {
  command: string;
  cwd: string;
  env: Record<string, string>;
  inspection: OpenCodeModelsOutputInspection;
  attempts: number;
}): Promise<Error> {
  const { command, inspection, attempts } = input;
  const version = await probeOpenCodeVersion({ command, cwd: input.cwd, env: input.env });
  const source =
    command === "opencode"
      ? 'resolved from PATH'
      : "set explicitly via adapterConfig.command or PAPERCLIP_OPENCODE_COMMAND";
  const identity = `command "${command}" (${source}), \`--version\` -> ${version}`;
  const attemptSuffix = `on ${attempts} consecutive attempt${attempts === 1 ? "" : "s"}`;
  const guidance =
    "This usually means the resolved OpenCode CLI does not implement the v1.x `models` " +
    "contract this adapter was written against: v2+ is a thin client for a background " +
    "`opencode serve` daemon and can exit 0 while emitting no models for a given workspace. " +
    "Point PAPERCLIP_OPENCODE_COMMAND (or adapterConfig.command) at a known-good v1.x binary, " +
    "or set OPENCODE_ALLOW_ALL_MODELS=true to skip discovery and trust adapterConfig.model.";

  if (inspection.unparsedLines.length === 0) {
    return new Error(
      `OpenCode returned no models: \`opencode models\` exited 0 with empty stdout ${attemptSuffix} ` +
        `using ${identity}. ${guidance}`,
    );
  }

  return new Error(
    `OpenCode returned no models: \`opencode models\` produced ${inspection.unparsedLines.length} ` +
      `line(s) with no \`provider/model\` id ${attemptSuffix} using ${identity}. First unrecognized lines: ` +
      `${sampleOutputLines(inspection.unparsedLines)}. ${guidance}`,
  );
}

export interface OpenCodeModelsOutputInspection {
  models: AdapterModel[];
  /** Non-empty stdout lines the parser could not turn into a `provider/model` id. */
  unparsedLines: string[];
}

/**
 * Parses `opencode models` stdout while keeping the lines it could not
 * interpret, so callers can diagnose a CLI contract break instead of silently
 * degrading to an empty model list.
 */
export function inspectOpenCodeModelsOutput(stdout: string): OpenCodeModelsOutputInspection {
  const parsed: AdapterModel[] = [];
  const unparsedLines: string[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const firstToken = line.split(/\s+/)[0]?.trim() ?? "";
    const separatorIndex = firstToken.indexOf("/");
    if (separatorIndex <= 0) {
      unparsedLines.push(line);
      continue;
    }
    const provider = firstToken.slice(0, separatorIndex).trim();
    const model = firstToken.slice(separatorIndex + 1).trim();
    if (!provider || !model) {
      unparsedLines.push(line);
      continue;
    }
    parsed.push({ id: `${provider}/${model}`, label: `${provider}/${model}` });
  }
  return { models: dedupeModels(parsed), unparsedLines };
}

export function parseOpenCodeModelsOutput(stdout: string): AdapterModel[] {
  return inspectOpenCodeModelsOutput(stdout).models;
}

function normalizeEnv(input: unknown): Record<string, string> {
  const envInput = typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envInput)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

function isVolatileEnvKey(key: string): boolean {
  if (VOLATILE_ENV_KEY_EXACT.has(key)) return true;
  return VOLATILE_ENV_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function discoveryCacheKey(command: string, cwd: string, env: Record<string, string>) {
  const envKey = Object.entries(env)
    .filter(([key]) => !isVolatileEnvKey(key))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${hashValue(value)}`)
    .join("\n");
  return `${command}\n${cwd}\n${envKey}`;
}

function pruneExpiredDiscoveryCache(now: number) {
  for (const [key, value] of discoveryCache.entries()) {
    if (value.expiresAt <= now) discoveryCache.delete(key);
  }
}

export async function discoverOpenCodeModels(input: {
  command?: unknown;
  cwd?: unknown;
  env?: unknown;
} = {}): Promise<AdapterModel[]> {
  const command = resolveOpenCodeCommand(input.command);
  const cwd = asString(input.cwd, process.cwd());
  const env = normalizeEnv(input.env);
  // Ensure HOME points to the actual running user's home directory.
  // When the server is started via `runuser -u <user>`, HOME may still
  // reflect the parent process (e.g. /root), causing OpenCode to miss
  // provider auth credentials stored under the target user's home.
  let resolvedHome: string | undefined;
  try {
    resolvedHome = os.userInfo().homedir || undefined;
  } catch {
    // os.userInfo() throws a SystemError when the current UID has no
    // /etc/passwd entry (e.g. `docker run --user 1234` with a minimal
    // image). Fall back to process.env.HOME.
  }
  // Prevent OpenCode from writing an opencode.json into the working directory.
  const runtimeEnv = normalizeEnv(ensurePathInEnv({ ...process.env, ...env, ...(resolvedHome ? { HOME: resolvedHome } : {}), OPENCODE_DISABLE_PROJECT_CONFIG: "true" }));

  // `opencode models` on v2.x can exit 0 with empty stdout when the thin
  // client loses a race with the background `opencode serve` daemon (observed
  // intermittently: the same command/cwd/env returns 0 bytes once and a full
  // listing moments later). A single empty result is therefore transient, not
  // fatal; only N consecutive empty/unusable results fail the pre-flight.
  let inspection: OpenCodeModelsOutputInspection = { models: [], unparsedLines: [] };
  for (let attempt = 1; attempt <= MODELS_DISCOVERY_ATTEMPTS; attempt += 1) {
    const result = await runChildProcess(
      `opencode-models-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      command,
      ["models"],
      {
        cwd,
        env: runtimeEnv,
        timeoutSec: MODELS_DISCOVERY_TIMEOUT_MS / 1000,
        graceSec: 3,
        onLog: async () => {},
      },
    );

    if (result.timedOut) {
      throw new Error(`\`opencode models\` timed out after ${MODELS_DISCOVERY_TIMEOUT_MS / 1000}s.`);
    }
    if ((result.exitCode ?? 1) !== 0) {
      const detail = firstNonEmptyLine(result.stderr) || firstNonEmptyLine(result.stdout);
      throw new Error(detail ? `\`opencode models\` failed: ${detail}` : "`opencode models` failed.");
    }

    inspection = inspectOpenCodeModelsOutput(result.stdout);
    if (inspection.models.length > 0) return sortModels(inspection.models);
    if (attempt < MODELS_DISCOVERY_ATTEMPTS) {
      await sleep(resolveRetryDelayMs());
    }
  }

  // Exit 0 with no usable ids is fatal for model selection. Fail here with the
  // resolved command and its version instead of returning an empty list that
  // later surfaces as a misleading "verify provider auth" error.
  throw await describeUnusableModelsOutput({
    command,
    cwd,
    env: runtimeEnv,
    inspection,
    attempts: MODELS_DISCOVERY_ATTEMPTS,
  });
}

export async function discoverOpenCodeModelsCached(input: {
  command?: unknown;
  cwd?: unknown;
  env?: unknown;
} = {}): Promise<AdapterModel[]> {
  const command = resolveOpenCodeCommand(input.command);
  const cwd = asString(input.cwd, process.cwd());
  const env = normalizeEnv(input.env);
  const key = discoveryCacheKey(command, cwd, env);
  const now = Date.now();
  pruneExpiredDiscoveryCache(now);
  const cached = discoveryCache.get(key);
  if (cached && cached.expiresAt > now) return cached.models;

  const models = await discoverOpenCodeModels({ command, cwd, env });
  discoveryCache.set(key, { expiresAt: now + MODELS_CACHE_TTL_MS, models });
  return models;
}

export function isTruthyEnvFlag(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

export async function ensureOpenCodeModelConfiguredAndAvailable(input: {
  model?: unknown;
  command?: unknown;
  cwd?: unknown;
  env?: unknown;
}): Promise<AdapterModel[]> {
  const model = requireOpenCodeModelId(input.model);

  // When the caller opts into OPENCODE_ALLOW_ALL_MODELS, OpenCode accepts any
  // provider/model at run time (e.g. gateway-routed models that never appear in
  // `opencode models` output). Honour that by skipping the availability probe;
  // we still enforce the provider/model format above and do not second-guess
  // the configured model. Prefer the explicit run env, then the process env.
  const env = normalizeEnv(input.env);
  if (isTruthyEnvFlag(env.OPENCODE_ALLOW_ALL_MODELS ?? process.env.OPENCODE_ALLOW_ALL_MODELS)) {
    return [{ id: model, label: model }];
  }

  const models = await discoverOpenCodeModelsCached({
    command: input.command,
    cwd: input.cwd,
    env: input.env,
  });

  if (models.length === 0) {
    // Defensive: discovery already rejects an unusable `opencode models` result
    // with a command/version-specific diagnostic. Kept so a future discovery
    // change that returns [] again cannot silently look like empty provider auth.
    throw new Error(
      `OpenCode returned no models using command "${resolveOpenCodeCommand(input.command)}". ` +
        "Run `opencode models` and confirm the resolved binary emits `provider/model` ids.",
    );
  }

  if (!models.some((entry) => entry.id === model)) {
    const sample = models.slice(0, 12).map((entry) => entry.id).join(", ");
    throw new Error(
      `Configured OpenCode model is unavailable: ${model}. Available models: ${sample}${models.length > 12 ? ", ..." : ""}`,
    );
  }

  return models;
}

export async function listOpenCodeModels(): Promise<AdapterModel[]> {
  try {
    return await discoverOpenCodeModelsCached();
  } catch {
    return [];
  }
}

export function resetOpenCodeModelsCacheForTests() {
  discoveryCache.clear();
}
