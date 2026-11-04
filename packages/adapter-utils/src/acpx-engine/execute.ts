import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  adapterExecutionTargetSessionIdentity,
  formatAdapterExecutionTimeoutErrorMessage,
  formatAdapterExecutionTimeoutStartLogLine,
  readAdapterExecutionTarget,
  resolveAdapterExecutionTargetTimeout,
  type AdapterExecutionTargetTimeoutResolution,
} from "@paperclipai/adapter-utils/execution-target";
import {
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  applyPaperclipWorkspaceEnv,
  asNumber,
  asString,
  buildInvocationEnvForLogs,
  buildPaperclipEnv,
  ensureAbsoluteDirectory,
  ensurePathInEnv,
  ensurePaperclipSkillSymlink,
  joinPromptSections,
  materializePaperclipSkillCopy,
  parseObject,
  readPaperclipRuntimeSkillEntries,
  readPaperclipIssueWorkModeFromContext,
  renderPaperclipWakePrompt,
  renderTemplate,
  resolvePaperclipInstanceRootForAdapter,
  resolvePaperclipDesiredSkillNames,
  removeMaintainerOnlySkillSymlinks,
  rewriteWorkspaceCwdEnvVarsForExecution,
  shapePaperclipWorkspaceEnvForExecution,
  stringifyPaperclipWakePayload,
  type PaperclipSkillEntry,
} from "@paperclipai/adapter-utils/server-utils";
import { shellQuote } from "@paperclipai/adapter-utils/ssh";
import {
  createAcpRuntime,
  createAgentRegistry,
  createRuntimeStore,
  isAcpRuntimeError,
  type AcpAgentRegistry,
  type AcpRuntime,
  type AcpRuntimeEvent,
  type AcpRuntimeHandle,
  type AcpRuntimeOptions,
  type AcpRuntimeTurn,
  type AcpRuntimeTurnResult,
} from "acpx/runtime";
import {
  DEFAULT_ACP_ENGINE_AGENT,
  DEFAULT_ACP_ENGINE_MODE,
  DEFAULT_ACP_ENGINE_NON_INTERACTIVE_PERMISSIONS,
  DEFAULT_ACP_ENGINE_PERMISSION_MODE,
  DEFAULT_ACP_ENGINE_TIMEOUT_SEC,
  DEFAULT_ACP_ENGINE_WARM_HANDLE_IDLE_MS,
} from "./constants.js";
import { classifyContextWindowOverflowFailure } from "./context-overflow.js";
import { classifyTransientUpstreamFailure } from "./transient-upstream.js";
import {
  DEFAULT_CONTEXT_USAGE_STOP_RATIO,
  DEFAULT_TRANSCRIPT_BUDGET_CHARS,
  TRANSCRIPT_OVERFLOW_ERROR_CODE,
  TRANSCRIPT_OVERFLOW_ERROR_FAMILY,
  buildTranscriptStop,
  classifyContextOverflowCause,
  evaluateTranscriptBudget,
  measureTranscriptEventChars,
  mergeContextUsageSample,
  readContextUsageSample,
  type ContextUsageSample,
  type TranscriptStop,
} from "./transcript-budget.js";

const defaultModuleDir = path.dirname(fileURLToPath(import.meta.url));
/**
 * How much of a stopped attempt's partial progress is kept as durable state.
 *
 * The partial progress is what the next attempt resumes from, so it must be
 * long enough to be useful and short enough not to re-inflate the very
 * context window that overflowed.
 */
const TRANSCRIPT_PARTIAL_PROGRESS_MAX_CHARS = 4_000;
const WRAPPER_CLEANUP_RETENTION_MS = 15 * 60 * 1000;
/** Marker line in a wrapper script that names the env file it sources. */
const WRAPPER_ENV_FILE_MARKER = "# paperclip-wrapper-env-file=";

type AcpxSessionRecord = {
  agent_command?: unknown;
  agentCommand?: unknown;
  closed?: unknown;
  cwd?: unknown;
  name?: unknown;
};
const PAPERCLIP_MANAGED_CODEX_SKILLS_MANIFEST = ".paperclip-managed-skills.json";

type AcpxRuntimeFactory = (options: AcpRuntimeOptions) => AcpRuntime;

export interface RuntimeCacheEntry {
  runtime: AcpRuntime;
  handle: AcpRuntimeHandle;
  fingerprint: string;
  lastUsedAt: number;
  cleanupTimer?: NodeJS.Timeout;
}

interface AcpxEngineSettings {
  adapterType: string;
  moduleDir: string;
  packageRootDir: string;
}

export interface AcpxEngineExecutorOptions {
  createRuntime?: AcpxRuntimeFactory;
  now?: () => number;
  warmHandles?: Map<string, RuntimeCacheEntry>;
  adapterType?: string;
  moduleDir?: string;
  packageRootDir?: string;
}

interface AcpxPreparedRuntime {
  acpxAgent: string;
  mode: "persistent" | "oneshot";
  cwd: string;
  workspaceId: string;
  workspaceRepoUrl: string;
  workspaceRepoRef: string;
  env: Record<string, string>;
  loggedEnv: Record<string, string>;
  stateDir: string;
  permissionMode: "approve-all" | "approve-reads" | "deny-all";
  nonInteractivePermissions: "deny" | "fail";
  requestedModel: string;
  requestedThinkingEffort: string;
  fastMode: boolean;
  timeoutSec: number;
  timeoutResolution: AdapterExecutionTargetTimeoutResolution;
  sessionKey: string;
  fingerprint: string;
  agentCommand: string | null;
  agentRegistry: AcpAgentRegistry;
  remoteExecutionIdentity: Record<string, unknown> | null;
  skillPromptInstructions: string;
  skillsIdentity: Record<string, unknown>;
  childStderrLogPath: string | null;
  paperclipClaudeSettings: PaperclipClaudeSettingsResult | null;
}

const defaultWarmHandles = new Map<string, RuntimeCacheEntry>();

function resolveEngineSettings(options: AcpxEngineExecutorOptions): AcpxEngineSettings {
  const moduleDir = path.resolve(options.moduleDir ?? defaultModuleDir);
  return {
    adapterType: options.adapterType?.trim() || "acp_engine",
    moduleDir,
    packageRootDir: path.resolve(options.packageRootDir ?? path.resolve(moduleDir, "../..")),
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function shortHash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex").slice(0, 16);
}

function defaultPaperclipInstanceDir(): string {
  const home = process.env.PAPERCLIP_HOME?.trim() || path.join(os.homedir(), ".paperclip");
  const instanceId = process.env.PAPERCLIP_INSTANCE_ID?.trim() || "default";
  return resolvePaperclipInstanceRootForAdapter({
    homeDir: home,
    instanceId,
  });
}

function defaultStateDir(companyId: string, agentId: string): string {
  return path.join(defaultPaperclipInstanceDir(), "companies", companyId, "acp-engine", "agents", agentId);
}

function resolveManagedCodexHomeDir(companyId: string): string {
  return path.join(defaultPaperclipInstanceDir(), "companies", companyId, "codex-home");
}

// Walk up from startDir looking for `node_modules/.bin/<binName>`. This matches
// npm/pnpm binary hoisting in packaged installs while preserving monorepo dev.
export async function findAncestorBin(startDir: string, binName: string): Promise<string | null> {
  let current = path.resolve(startDir);
  while (true) {
    const candidate = path.join(current, "node_modules", ".bin", binName);
    if (await pathExists(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

interface BuiltInAgentCommand {
  command: string;
  shellCommand: string;
}

async function resolveBuiltInAgentCommand(agent: string, packageRootDir: string): Promise<BuiltInAgentCommand | null> {
  if (agent === "gemini") {
    return { command: "gemini --acp", shellCommand: "gemini --acp" };
  }
  const binName = agent === "claude" ? "claude-agent-acp" : agent === "codex" ? "codex-acp" : null;
  if (!binName) return null;
  const resolved = (await findAncestorBin(packageRootDir, binName)) ?? binName;
  return { command: resolved, shellCommand: shellQuote(resolved) };
}

const execFileAsync = promisify(execFile);
// Gemini CLI renamed --experimental-acp to --acp in 0.33.0. acpx normally
// rewrites the flag itself, but the agent wrapper script hides the gemini
// command from acpx's detection, so the engine must downgrade it here.
const GEMINI_NATIVE_ACP_FLAG_MIN_VERSION = [0, 33, 0] as const;
const GEMINI_VERSION_PROBE_TIMEOUT_MS = 2000;

export function parseGeminiVersionParts(output: string | null | undefined): number[] | null {
  const match = output?.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function geminiVersionSupportsNativeAcpFlag(parts: number[] | null): boolean {
  if (!parts) return true;
  for (let index = 0; index < GEMINI_NATIVE_ACP_FLAG_MIN_VERSION.length; index += 1) {
    const diff = (parts[index] ?? 0) - GEMINI_NATIVE_ACP_FLAG_MIN_VERSION[index];
    if (diff !== 0) return diff > 0;
  }
  return true;
}

export function rewriteGeminiAcpFlagForVersion(commandShell: string, versionParts: number[] | null): string {
  if (geminiVersionSupportsNativeAcpFlag(versionParts)) return commandShell;
  return commandShell
    .trim()
    .split(/\s+/)
    .map((token) => (token === "--acp" ? "--experimental-acp" : token))
    .join(" ");
}

function geminiAcpCommandTokens(commandShell: string): string[] | null {
  const tokens = commandShell.trim().split(/\s+/);
  const bin = tokens[0];
  if (!bin || bin.startsWith("'") || bin.startsWith('"')) return null;
  if (path.basename(bin) !== "gemini") return null;
  if (!tokens.includes("--acp")) return null;
  return tokens;
}

async function normalizeGeminiAcpCommandShell(commandShell: string, env: NodeJS.ProcessEnv): Promise<string> {
  const tokens = geminiAcpCommandTokens(commandShell);
  if (!tokens) return commandShell;
  let versionParts: number[] | null = null;
  try {
    const { stdout } = await execFileAsync(tokens[0], ["--version"], {
      timeout: GEMINI_VERSION_PROBE_TIMEOUT_MS,
      encoding: "utf8",
      env,
    });
    versionParts = parseGeminiVersionParts(stdout);
  } catch {
    return commandShell;
  }
  return rewriteGeminiAcpFlagForVersion(commandShell, versionParts);
}

function normalizeAgent(config: Record<string, unknown>): string {
  const agent = asString(config.agent, DEFAULT_ACP_ENGINE_AGENT).trim();
  return agent || DEFAULT_ACP_ENGINE_AGENT;
}

async function pathExists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true).catch(() => false);
}

async function ensureParentDir(target: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
}

async function writeFileAtomically(input: {
  target: string;
  contents: string;
  mode: number;
}): Promise<void> {
  await ensureParentDir(input.target);
  const tempPath = `${input.target}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await fs.open(tempPath, "wx", input.mode);
  try {
    await handle.writeFile(input.contents, "utf8");
    await handle.close();
    await fs.rename(tempPath, input.target);
    await fs.chmod(input.target, input.mode).catch(() => {});
  } catch (err) {
    await handle.close().catch(() => {});
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw err;
  }
}

async function ensureSymlink(target: string, source: string): Promise<void> {
  const resolvedSource = path.resolve(source);
  const existing = await fs.lstat(target).catch(() => null);
  if (!existing) {
    await ensureParentDir(target);
    await fs.symlink(resolvedSource, target);
    return;
  }

  if (!existing.isSymbolicLink()) {
    await fs.rm(target, { recursive: true, force: true });
    await fs.symlink(resolvedSource, target);
    return;
  }

  const linkedPath = await fs.readlink(target).catch(() => null);
  if (!linkedPath) return;

  const resolvedLinkedPath = path.resolve(path.dirname(target), linkedPath);
  if (resolvedLinkedPath === resolvedSource) return;

  await fs.unlink(target);
  await fs.symlink(resolvedSource, target);
}

async function ensureCopiedFile(target: string, source: string): Promise<void> {
  if (await pathExists(target)) return;
  await ensureParentDir(target);
  await fs.copyFile(source, target);
}

async function prepareManagedCodexHome(input: {
  companyId: string;
  sourceHome: string;
  targetHome: string;
  onLog: AdapterExecutionContext["onLog"];
}): Promise<string> {
  const { sourceHome, targetHome, onLog } = input;
  if (path.resolve(sourceHome) === path.resolve(targetHome)) return targetHome;

  await fs.mkdir(targetHome, { recursive: true });

  const authJson = path.join(sourceHome, "auth.json");
  if (await pathExists(authJson)) await ensureSymlink(path.join(targetHome, "auth.json"), authJson);

  for (const name of ["config.json", "config.toml", "instructions.md"]) {
    const source = path.join(sourceHome, name);
    if (await pathExists(source)) await ensureCopiedFile(path.join(targetHome, name), source);
  }

  await onLog(
    "stdout",
    `[paperclip] Using Paperclip-managed ACPX Codex home "${targetHome}" (seeded from "${sourceHome}").\n`,
  );
  return targetHome;
}

async function hashPathContents(
  candidate: string,
  hash: ReturnType<typeof createHash>,
  relativePath: string,
  seenDirectories: Set<string>,
): Promise<void> {
  const stat = await fs.lstat(candidate);

  if (stat.isSymbolicLink()) {
    hash.update(`symlink-skipped:${relativePath}\n`);
    return;
  }

  if (stat.isDirectory()) {
    const realDir = await fs.realpath(candidate).catch(() => candidate);
    hash.update(`dir:${relativePath}\n`);
    if (seenDirectories.has(realDir)) {
      hash.update("loop\n");
      return;
    }
    seenDirectories.add(realDir);
    const entries = await fs.readdir(candidate, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const childRelativePath = relativePath.length > 0 ? `${relativePath}/${entry.name}` : entry.name;
      await hashPathContents(path.join(candidate, entry.name), hash, childRelativePath, seenDirectories);
    }
    return;
  }

  if (stat.isFile()) {
    hash.update(`file:${relativePath}\n`);
    hash.update(await fs.readFile(candidate));
    hash.update("\n");
    return;
  }

  hash.update(`other:${relativePath}:${stat.mode}\n`);
}

async function buildSkillSetKey(input: {
  skills: PaperclipSkillEntry[];
  label: string;
}): Promise<string> {
  const hash = createHash("sha256");
  hash.update(`paperclip-acpx-${input.label}-skills:v1\n`);
  const sorted = [...input.skills].sort((left, right) => left.runtimeName.localeCompare(right.runtimeName));
  for (const entry of sorted) {
    hash.update(`skill:${entry.key}:${entry.runtimeName}\n`);
    await hashPathContents(entry.source, hash, entry.runtimeName, new Set<string>());
  }
  return hash.digest("hex");
}

async function resolveSelectedRuntimeSkills(
  config: Record<string, unknown>,
  moduleDir: string,
): Promise<{ allSkills: PaperclipSkillEntry[]; selectedSkills: PaperclipSkillEntry[]; desiredSkillNames: string[] }> {
  const allSkills = await readPaperclipRuntimeSkillEntries(config, moduleDir);
  const desiredSkillNames = resolvePaperclipDesiredSkillNames(config, allSkills);
  const desiredSet = new Set(desiredSkillNames);
  return {
    allSkills,
    selectedSkills: allSkills.filter((entry) => desiredSet.has(entry.key)),
    desiredSkillNames,
  };
}

async function prepareClaudeSkillRuntime(input: {
  stateDir: string;
  config: Record<string, unknown>;
  moduleDir: string;
  onLog: AdapterExecutionContext["onLog"];
}): Promise<{
  identity: Record<string, unknown>;
  promptInstructions: string;
  commandNotes: string[];
}> {
  const { allSkills, selectedSkills, desiredSkillNames } = await resolveSelectedRuntimeSkills(input.config, input.moduleDir);
  const skillSetKey = await buildSkillSetKey({ skills: selectedSkills, label: "claude" });
  const bundleRoot = path.join(input.stateDir, "runtime-skills", "claude", skillSetKey);
  const skillsHome = path.join(bundleRoot, ".claude", "skills");
  await fs.mkdir(skillsHome, { recursive: true });

  for (const entry of selectedSkills) {
    const target = path.join(skillsHome, entry.runtimeName);
    try {
      const result = await materializePaperclipSkillCopy(entry.source, target);
      if (result.skippedSymlinks.length > 0) {
        await input.onLog(
          "stdout",
          `[paperclip] Materialized ACPX Claude skill "${entry.runtimeName}" into ${skillsHome} and skipped ${result.skippedSymlinks.length} symlink(s).\n`,
        );
      }
    } catch (err) {
      await input.onLog(
        "stderr",
        `[paperclip] Failed to materialize ACPX Claude skill "${entry.key}" into ${skillsHome}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  const selectedNames = selectedSkills.map((entry) => entry.runtimeName).sort();
  const promptInstructions = selectedSkills.length > 0
    ? [
        "Paperclip has materialized selected runtime skills for this ACPX Claude session.",
        `Skill root: ${skillsHome}`,
        selectedNames.length > 0 ? `Selected skills: ${selectedNames.join(", ")}` : "",
        "When a task calls for one of these skills, read its SKILL.md from that root and follow it.",
      ].filter(Boolean).join("\n")
    : "";

  return {
    identity: {
      mode: "claude",
      skillSetKey,
      desiredSkillNames,
      selectedSkills: selectedNames,
      skillRoot: selectedSkills.length > 0 ? skillsHome : null,
    },
    promptInstructions,
    commandNotes: selectedSkills.length > 0
      ? [`Materialized ${selectedSkills.length} Paperclip skill(s) for ACPX Claude at ${skillsHome}.`]
      : [],
  };
}

async function readManagedCodexSkillsManifest(skillsHome: string): Promise<Set<string>> {
  const manifestPath = path.join(skillsHome, PAPERCLIP_MANAGED_CODEX_SKILLS_MANIFEST);
  try {
    const raw = JSON.parse(await fs.readFile(manifestPath, "utf8")) as unknown;
    const parsed = parseObject(raw);
    const skills = Array.isArray(parsed.managedSkillNames)
      ? parsed.managedSkillNames.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : [];
    return new Set(skills);
  } catch {
    return new Set();
  }
}

async function writeManagedCodexSkillsManifest(skillsHome: string, skillNames: Iterable<string>): Promise<void> {
  const managedSkillNames = Array.from(new Set(skillNames)).sort();
  await fs.writeFile(
    path.join(skillsHome, PAPERCLIP_MANAGED_CODEX_SKILLS_MANIFEST),
    `${JSON.stringify({ version: 1, managedSkillNames }, null, 2)}\n`,
    "utf8",
  );
}

async function removeSkillTarget(target: string): Promise<boolean> {
  const existing = await fs.lstat(target).catch(() => null);
  if (!existing) return false;
  await fs.rm(target, { recursive: true, force: true });
  return true;
}

async function reconcileManagedCodexSkills(input: {
  skillsHome: string;
  allSkills: PaperclipSkillEntry[];
  selectedSkills: PaperclipSkillEntry[];
  onLog: AdapterExecutionContext["onLog"];
}): Promise<void> {
  const desired = new Set(input.selectedSkills.map((entry) => entry.runtimeName));
  const managed = await readManagedCodexSkillsManifest(input.skillsHome);
  const availableByRuntimeName = new Map(input.allSkills.map((entry) => [entry.runtimeName, entry]));

  for (const name of managed) {
    if (desired.has(name)) continue;
    if (await removeSkillTarget(path.join(input.skillsHome, name))) {
      await input.onLog("stdout", `[paperclip] Revoked ACPX Codex skill "${name}" from ${input.skillsHome}\n`);
    }
  }

  for (const entry of input.allSkills) {
    if (desired.has(entry.runtimeName) || managed.has(entry.runtimeName)) continue;
    const target = path.join(input.skillsHome, entry.runtimeName);
    const existing = await fs.lstat(target).catch(() => null);
    if (!existing?.isSymbolicLink()) continue;
    const linkedPath = await fs.readlink(target).catch(() => null);
    if (!linkedPath) continue;
    const resolvedLinkedPath = path.resolve(path.dirname(target), linkedPath);
    if (resolvedLinkedPath !== path.resolve(entry.source)) continue;
    if (await removeSkillTarget(target)) {
      await input.onLog("stdout", `[paperclip] Revoked legacy ACPX Codex skill "${entry.runtimeName}" from ${input.skillsHome}\n`);
    }
  }

  for (const name of managed) {
    if (desired.has(name) || availableByRuntimeName.has(name)) continue;
    if (await removeSkillTarget(path.join(input.skillsHome, name))) {
      await input.onLog("stdout", `[paperclip] Revoked unavailable ACPX Codex skill "${name}" from ${input.skillsHome}\n`);
    }
  }
}

async function prepareCodexSkillRuntime(input: {
  companyId: string;
  config: Record<string, unknown>;
  env: Record<string, string>;
  moduleDir: string;
  onLog: AdapterExecutionContext["onLog"];
}): Promise<{ identity: Record<string, unknown>; commandNotes: string[] }> {
  const envConfig = parseObject(input.config.env);
  const configuredCodexHome =
    typeof envConfig.CODEX_HOME === "string" && envConfig.CODEX_HOME.trim().length > 0
      ? path.resolve(envConfig.CODEX_HOME.trim())
      : null;
  const sourceCodexHome =
    typeof process.env.CODEX_HOME === "string" && process.env.CODEX_HOME.trim().length > 0
      ? path.resolve(process.env.CODEX_HOME.trim())
      : path.join(os.homedir(), ".codex");
  const managedCodexHome = resolveManagedCodexHomeDir(input.companyId);
  const effectiveCodexHome = configuredCodexHome ??
    await prepareManagedCodexHome({
      companyId: input.companyId,
      sourceHome: sourceCodexHome,
      targetHome: managedCodexHome,
      onLog: input.onLog,
    });
  const { allSkills, selectedSkills, desiredSkillNames } = await resolveSelectedRuntimeSkills(input.config, input.moduleDir);
  const skillSetKey = await buildSkillSetKey({ skills: selectedSkills, label: "codex" });
  const skillsHome = path.join(effectiveCodexHome, "skills");
  await fs.mkdir(skillsHome, { recursive: true });
  await reconcileManagedCodexSkills({
    skillsHome,
    allSkills,
    selectedSkills,
    onLog: input.onLog,
  });

  for (const entry of selectedSkills) {
    const target = path.join(skillsHome, entry.runtimeName);
    try {
      const result = await materializePaperclipSkillCopy(entry.source, target);
      if (result.skippedSymlinks.length > 0) {
        await input.onLog(
          "stdout",
          `[paperclip] Materialized ACPX Codex skill "${entry.runtimeName}" into ${skillsHome} and skipped ${result.skippedSymlinks.length} symlink(s).\n`,
        );
      }
    } catch (err) {
      await input.onLog(
        "stderr",
        `[paperclip] Failed to inject ACPX Codex skill "${entry.key}" into ${skillsHome}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
  await writeManagedCodexSkillsManifest(skillsHome, selectedSkills.map((entry) => entry.runtimeName));

  input.env.CODEX_HOME = effectiveCodexHome;

  return {
    identity: {
      mode: "codex",
      skillSetKey,
      desiredSkillNames,
      selectedSkills: selectedSkills.map((entry) => entry.runtimeName).sort(),
      codexHome: effectiveCodexHome,
      skillsHome,
    },
    commandNotes: [`Prepared ACPX Codex skill home at ${skillsHome}.`],
  };
}

function resolveGeminiSkillsHome(config: Record<string, unknown>): string {
  const envConfig = parseObject(config.env);
  const configuredHome =
    typeof envConfig.HOME === "string" && envConfig.HOME.trim().length > 0
      ? path.resolve(envConfig.HOME.trim())
      : os.homedir();
  return path.join(configuredHome, ".gemini", "skills");
}

async function prepareGeminiSkillRuntime(input: {
  config: Record<string, unknown>;
  moduleDir: string;
  onLog: AdapterExecutionContext["onLog"];
}): Promise<{ identity: Record<string, unknown>; commandNotes: string[] }> {
  const { selectedSkills, desiredSkillNames } = await resolveSelectedRuntimeSkills(input.config, input.moduleDir);
  const skillSetKey = await buildSkillSetKey({ skills: selectedSkills, label: "gemini" });
  const skillsHome = resolveGeminiSkillsHome(input.config);
  await fs.mkdir(skillsHome, { recursive: true });

  const allowedSkillNames = selectedSkills.map((entry) => entry.runtimeName);
  const removedSkills = await removeMaintainerOnlySkillSymlinks(skillsHome, allowedSkillNames);
  for (const skillName of removedSkills) {
    await input.onLog("stdout", `[paperclip] Removed maintainer-only ACPX Gemini skill "${skillName}" from ${skillsHome}\n`);
  }

  for (const entry of selectedSkills) {
    const target = path.join(skillsHome, entry.runtimeName);
    try {
      const result = await ensurePaperclipSkillSymlink(entry.source, target);
      if (result === "created" || result === "repaired") {
        await input.onLog(
          "stdout",
          `[paperclip] ${result === "repaired" ? "Repaired" : "Linked"} ACPX Gemini skill "${entry.runtimeName}" into ${skillsHome}\n`,
        );
      }
    } catch (err) {
      await input.onLog(
        "stderr",
        `[paperclip] Failed to link ACPX Gemini skill "${entry.key}" into ${skillsHome}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  return {
    identity: {
      mode: "gemini",
      skillSetKey,
      desiredSkillNames,
      selectedSkills: selectedSkills.map((entry) => entry.runtimeName).sort(),
      skillsHome,
    },
    commandNotes: selectedSkills.length > 0
      ? [`Prepared ${selectedSkills.length} ACPX Gemini skill(s) at ${skillsHome}.`]
      : [],
  };
}

function normalizeMode(config: Record<string, unknown>): "persistent" | "oneshot" {
  return asString(config.mode, DEFAULT_ACP_ENGINE_MODE) === "oneshot" ? "oneshot" : "persistent";
}

function normalizePermissionMode(config: Record<string, unknown>): "approve-all" | "approve-reads" | "deny-all" {
  const value = asString(config.permissionMode, DEFAULT_ACP_ENGINE_PERMISSION_MODE).trim();
  if (value === "approve-reads" || value === "deny-all") return value;
  if (value === "default") return "approve-reads";
  return "approve-all";
}

function normalizeNonInteractivePermissions(config: Record<string, unknown>): "deny" | "fail" {
  return asString(config.nonInteractivePermissions, DEFAULT_ACP_ENGINE_NON_INTERACTIVE_PERMISSIONS) === "fail"
    ? "fail"
    : "deny";
}

function normalizeRequestedThinkingEffort(config: Record<string, unknown>): string {
  return (
    asString(config.modelReasoningEffort, "") ||
    asString(config.reasoningEffort, "") ||
    asString(config.thinkingEffort, "") ||
    asString(config.effort, "")
  ).trim();
}

function isCompatibleSession(
  params: Record<string, unknown>,
  runtime: Pick<AcpxPreparedRuntime, "fingerprint" | "sessionKey" | "cwd" | "mode" | "acpxAgent" | "remoteExecutionIdentity">,
): boolean {
  if (asString(params.configFingerprint, "") !== runtime.fingerprint) return false;
  if (asString(params.sessionKey, "") !== runtime.sessionKey) return false;
  if (asString(params.agent, "") !== runtime.acpxAgent) return false;
  if (asString(params.mode, "") !== runtime.mode) return false;
  const savedCwd = asString(params.cwd, "");
  if (!savedCwd || path.resolve(savedCwd) !== path.resolve(runtime.cwd)) return false;
  const savedRemote = parseObject(params.remoteExecution);
  return stableJson(savedRemote) === stableJson(runtime.remoteExecutionIdentity ?? {});
}

function buildSessionParams(input: {
  prepared: AcpxPreparedRuntime;
  handle: AcpRuntimeHandle;
}): Record<string, unknown> {
  const { prepared, handle } = input;
  return {
    sessionKey: prepared.sessionKey,
    runtimeSessionName: handle.runtimeSessionName,
    acpxRecordId: handle.acpxRecordId,
    acpSessionId: handle.backendSessionId,
    agentSessionId: handle.agentSessionId,
    agent: prepared.acpxAgent,
    cwd: prepared.cwd,
    mode: prepared.mode,
    stateDir: prepared.stateDir,
    configFingerprint: prepared.fingerprint,
    ...(prepared.requestedModel ? { model: prepared.requestedModel } : {}),
    ...(prepared.requestedThinkingEffort ? { thinkingEffort: prepared.requestedThinkingEffort } : {}),
    ...(prepared.fastMode ? { fastMode: true } : {}),
    skills: prepared.skillsIdentity,
    ...(prepared.workspaceId ? { workspaceId: prepared.workspaceId } : {}),
    ...(prepared.workspaceRepoUrl ? { repoUrl: prepared.workspaceRepoUrl } : {}),
    ...(prepared.workspaceRepoRef ? { repoRef: prepared.workspaceRepoRef } : {}),
    ...(prepared.remoteExecutionIdentity ? { remoteExecution: prepared.remoteExecutionIdentity } : {}),
  };
}

interface PaperclipClaudeSettingsResult {
  filePath: string;
  allow: string[];
  additionalDirectories: string[];
  defaultMode: string;
  overrodeDontAsk: boolean;
}

function uniqueSorted(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))].sort();
}

// The Claude Code SDK that `claude-agent-acp` runs uses
// `settingSources: ["user", "project", "local"]`. By writing a per-worktree
// `.claude/settings.local.json` we override the user's potentially-restrictive
// `~/.claude/settings.json` (e.g. `defaultMode: "dontAsk"`, which silently
// denies every non-allowlisted tool and never reaches `canUseTool`), and we
// widen the SDK's Read sandbox to include the Paperclip state dirs the agent
// needs to talk to its own control plane.
async function writePaperclipClaudeSettings(input: {
  cwd: string;
  stateDir: string;
  agentHome: string;
  companyId: string;
}): Promise<PaperclipClaudeSettingsResult> {
  const filePath = path.join(input.cwd, ".claude", "settings.local.json");
  const instanceRoot = defaultPaperclipInstanceDir();
  const companyRoot = path.join(instanceRoot, "companies", input.companyId);
  const paperclipAdditionalDirectories = uniqueSorted([
    input.stateDir,
    input.agentHome,
    companyRoot,
  ]);
  const paperclipAllow = uniqueSorted([
    "Bash(curl:*)",
    "Bash(env:*)",
    "Bash(env)",
    `Bash(${input.cwd}/scripts/paperclip-issue-update.sh:*)`,
    `Bash(${input.cwd}/scripts/paperclip:*)`,
  ]);

  let existing: Record<string, unknown> = {};
  const existingRaw = await fs.readFile(filePath, "utf8").catch(() => null);
  if (existingRaw) {
    try {
      const parsed = JSON.parse(existingRaw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) existing = parsed as Record<string, unknown>;
    } catch {
      // Malformed settings file — leave it alone in `existing` and our merge will replace it with a valid one.
    }
  }
  const existingPerms =
    existing.permissions && typeof existing.permissions === "object" && !Array.isArray(existing.permissions)
      ? (existing.permissions as Record<string, unknown>)
      : {};
  const existingAllow = Array.isArray(existingPerms.allow)
    ? (existingPerms.allow as unknown[]).filter((value): value is string => typeof value === "string")
    : [];
  const existingAdditionalDirectories = Array.isArray(existingPerms.additionalDirectories)
    ? (existingPerms.additionalDirectories as unknown[]).filter((value): value is string => typeof value === "string")
    : [];
  const mergedAllow = uniqueSorted([...existingAllow, ...paperclipAllow]);
  const mergedAdditionalDirectories = uniqueSorted([
    ...existingAdditionalDirectories,
    ...paperclipAdditionalDirectories,
  ]);
  const existingDefaultMode =
    typeof existingPerms.defaultMode === "string" ? (existingPerms.defaultMode as string) : "";
  const defaultMode =
    existingDefaultMode && existingDefaultMode !== "dontAsk" ? existingDefaultMode : "default";
  const overrodeDontAsk = existingDefaultMode === "dontAsk";

  const nextPermissions: Record<string, unknown> = {
    ...existingPerms,
    allow: mergedAllow,
    additionalDirectories: mergedAdditionalDirectories,
    defaultMode,
  };
  const next: Record<string, unknown> = { ...existing, permissions: nextPermissions };
  await writeFileAtomically({
    target: filePath,
    contents: `${JSON.stringify(next, null, 2)}\n`,
    mode: 0o600,
  });
  return {
    filePath,
    allow: mergedAllow,
    additionalDirectories: mergedAdditionalDirectories,
    defaultMode,
    overrodeDontAsk,
  };
}

/**
 * Stable identity of an agent wrapper script.
 *
 * The wrapper path must not churn per run. An ACPX session record persists the
 * wrapper path as its `agent_command`, and ACPX respawns that exact path when
 * the agent process has to come back. Hashing the run's env into the path (the
 * historical behavior) gave every run a brand new path, so a session that
 * stayed open pointed at a wrapper the cleanup sweep was free to delete.
 *
 * The identity is the agent, the command, the cwd and the task. The task is
 * part of it so two runs of the same agent on different tasks never share a
 * wrapper file (and therefore never share an env file).
 */
function agentWrapperStableKey(input: {
  acpxAgent: string;
  agentCommandShell: string;
  cwd: string;
  taskKey: string;
}): string {
  return shortHash({
    agent: input.acpxAgent,
    command: input.agentCommandShell,
    cwd: path.resolve(input.cwd),
    task: input.taskKey,
  });
}

function buildAgentWrapperScript(input: {
  envFilePath: string;
  agentCommandShell: string;
  childStderrDir: string;
}): string {
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    // Machine-readable marker so the wrapper's env file can be recovered
    // without re-deriving the naming scheme.
    `${WRAPPER_ENV_FILE_MARKER}${input.envFilePath}`,
    `env_file=${shellQuote(input.envFilePath)}`,
    "if [[ -f \"$env_file\" ]]; then",
    "  set -a",
    "  source \"$env_file\"",
    "  set +a",
    "fi",
    `stderr_dir=${shellQuote(input.childStderrDir)}`,
    "if [[ -n \"${PAPERCLIP_RUN_ID:-}\" ]]; then",
    "  mkdir -p \"$stderr_dir\"",
    // Keep the run-stderr file unfiltered, but do not forward the known-benign
    // ACP nes/close cleanup RPC error to Paperclip's live stderr stream.
    "  exec 2> >(tee -a \"$stderr_dir/$PAPERCLIP_RUN_ID.log\" | grep -Ev \"method: ['\\\"]nes/close['\\\"].*-32601\" >&2 || true)",
    "fi",
    `exec ${input.agentCommandShell} "$@"`,
    "",
  ].join("\n");
}

async function writeAgentWrapper(input: {
  stateDir: string;
  acpxAgent: string;
  agentCommandShell: string;
  env: Record<string, string>;
  childStderrDir: string;
  cwd: string;
  taskKey: string;
}): Promise<{ wrapperPath: string; envFilePath: string; script: string }> {
  const wrappersDir = path.join(input.stateDir, "wrappers");
  await fs.mkdir(wrappersDir, { recursive: true });
  const envLines = Object.entries(input.env)
    .filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${shellQuote(value)}`);
  const stableKey = agentWrapperStableKey({
    acpxAgent: input.acpxAgent,
    agentCommandShell: input.agentCommandShell,
    cwd: input.cwd,
    taskKey: input.taskKey,
  });
  // The env file stays per run (keyed by its contents) so concurrent runs with
  // different credentials never share one, while the wrapper script path stays
  // stable so a session's persisted `agent_command` survives.
  const envKey = shortHash(envLines);
  const wrapperPath = path.join(wrappersDir, `${input.acpxAgent}-${stableKey}.sh`);
  const envFilePath = path.join(wrappersDir, `${input.acpxAgent}-${stableKey}-${envKey}.env`);
  const script = buildAgentWrapperScript({
    envFilePath,
    agentCommandShell: input.agentCommandShell,
    childStderrDir: input.childStderrDir,
  });
  await writeFileAtomically({
    target: envFilePath,
    contents: `${envLines.join("\n")}\n`,
    mode: 0o600,
  });
  await writeFileAtomically({
    target: wrapperPath,
    contents: script,
    mode: 0o700,
  });
  await cleanupStaleAgentWrappers({
    wrappersDir,
    stateDir: input.stateDir,
    currentFileNames: new Set([path.basename(wrapperPath), path.basename(envFilePath)]),
  });
  return { wrapperPath, envFilePath, script };
}

function isInsideDir(candidate: string, dir: string): boolean {
  const relative = path.relative(path.resolve(dir), path.resolve(candidate));
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function readAcpxSessionRecord(filePath: string): Promise<AcpxSessionRecord | null> {
  const raw = await fs.readFile(filePath, "utf8").catch(() => null);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as AcpxSessionRecord) : null;
  } catch {
    return null;
  }
}

/** The wrapper path an ACPX session record was created with, if any. */
function sessionRecordWrapperPath(record: AcpxSessionRecord | null): string | null {
  if (!record) return null;
  const command = (asString(record.agent_command, "") || asString(record.agentCommand, "")).trim();
  if (!command) return null;
  // The persisted command is a command line; the wrapper path is its first token.
  const first = command.split(/\s+/)[0] ?? "";
  return first.length > 0 ? first : null;
}

async function readWrapperEnvFilePath(wrapperPath: string): Promise<string | null> {
  const script = await fs.readFile(wrapperPath, "utf8").catch(() => null);
  if (script === null) return null;
  for (const line of script.split("\n")) {
    if (!line.startsWith(WRAPPER_ENV_FILE_MARKER)) continue;
    const value = line.slice(WRAPPER_ENV_FILE_MARKER.length).trim();
    if (value.length > 0) return value;
  }
  return null;
}

/**
 * Wrapper paths that a still-open ACPX session depends on.
 *
 * A session may legitimately stay open for days, so age alone must never
 * decide a wrapper's life: any wrapper a non-closed session record points at
 * is protected, together with the env file that wrapper sources.
 */
async function collectOpenSessionWrapperPaths(stateDir: string): Promise<Set<string>> {
  const wrappersDir = path.join(stateDir, "wrappers");
  const sessionsDir = path.join(stateDir, "sessions");
  const protectedPaths = new Set<string>();
  const records = await fs.readdir(sessionsDir).catch(() => []);
  await Promise.all(
    records
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => {
        const record = await readAcpxSessionRecord(path.join(sessionsDir, name));
        if (!record || record.closed === true) return;
        const wrapperPath = sessionRecordWrapperPath(record);
        if (!wrapperPath) return;
        const resolved = path.resolve(wrapperPath);
        if (!isInsideDir(resolved, wrappersDir)) return;
        protectedPaths.add(resolved);
        const envFilePath = await readWrapperEnvFilePath(resolved);
        if (envFilePath) protectedPaths.add(path.resolve(envFilePath));
      }),
  );
  return protectedPaths;
}

async function cleanupStaleAgentWrappers(input: {
  wrappersDir: string;
  stateDir: string;
  currentFileNames: Set<string>;
}) {
  const protectedPaths = await collectOpenSessionWrapperPaths(input.stateDir);
  const wrappers = await fs.readdir(input.wrappersDir).catch(() => []);
  const now = Date.now();
  await Promise.all(
    wrappers.map(async (name) => {
      const isManagedWrapperFile = name.endsWith(".sh") || name.endsWith(".env");
      if (!isManagedWrapperFile || input.currentFileNames.has(name)) return;
      const wrapperPath = path.join(input.wrappersDir, name);
      const resolved = path.resolve(wrapperPath);
      if (protectedPaths.has(resolved)) return;
      const stats = await fs.stat(wrapperPath).catch(() => null);
      if (!stats || now - stats.mtimeMs < WRAPPER_CLEANUP_RETENTION_MS) return;
      // Read the env file pointer before the script goes away: a wrapper and
      // its env file are written as a pair.
      const envFilePath = name.endsWith(".sh") ? await readWrapperEnvFilePath(wrapperPath) : null;
      await fs.rm(wrapperPath, { force: true });
      if (!envFilePath) return;
      const resolvedEnv = path.resolve(envFilePath);
      if (protectedPaths.has(resolvedEnv)) return;
      if (input.currentFileNames.has(path.basename(resolvedEnv))) return;
      await fs.rm(resolvedEnv, { force: true }).catch(() => {});
    }),
  );
}

/**
 * Re-materialise the wrapper an ACPX session record points at.
 *
 * ACPX respawns the exact command a session record persisted. When that file
 * was swept (or predates the stable-path layout) the respawn dies with
 * ENOENT ("Failed to spawn agent command"). Rewriting the persisted path with
 * the current run's script keeps the session resumable and hands the respawned
 * agent the current run's credentials instead of the previous run's.
 *
 * Only an open session is materialised: a closed session is not resumable, so
 * its wrapper stays eligible for the age-based sweep.
 */
export async function materializeSessionWrapper(input: {
  stateDir: string;
  sessionKey: string;
  wrapperPath: string;
  script: string;
}): Promise<string | null> {
  const record = await readAcpxSessionRecord(
    path.join(input.stateDir, "sessions", `${encodeURIComponent(input.sessionKey)}.json`),
  );
  if (!record || record.closed === true) return null;
  const persistedPath = sessionRecordWrapperPath(record);
  if (!persistedPath) return null;
  const resolved = path.resolve(persistedPath);
  if (resolved === path.resolve(input.wrapperPath)) return null;
  if (!isInsideDir(resolved, path.join(input.stateDir, "wrappers"))) return null;
  await writeFileAtomically({ target: resolved, contents: input.script, mode: 0o700 });
  return resolved;
}

async function buildRuntime(input: {
  ctx: AdapterExecutionContext;
  engine: AcpxEngineSettings;
}): Promise<AcpxPreparedRuntime> {
  const { runId, agent, config, context, authToken } = input.ctx;
  const workspaceContext = parseObject(context.paperclipWorkspace);
  const secretsContext = parseObject(context.paperclipSecrets);
  const secretManifest = Array.isArray(secretsContext.manifest) ? secretsContext.manifest : [];
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceStrategy = asString(workspaceContext.strategy, "");
  const workspaceId = asString(workspaceContext.workspaceId, "");
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "");
  const workspaceRepoRef = asString(workspaceContext.repoRef, "");
  const workspaceBranch = asString(workspaceContext.branchName, "");
  const workspaceWorktreePath = asString(workspaceContext.worktreePath, "");
  const agentHome = asString(workspaceContext.agentHome, "");
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  const executionTarget = readAdapterExecutionTarget({
    executionTarget: input.ctx.executionTarget,
    legacyRemoteExecution: input.ctx.executionTransport?.remoteExecution,
  });
  const remoteExecutionIdentity = adapterExecutionTargetSessionIdentity(executionTarget);
  const effectiveExecutionCwd =
    remoteExecutionIdentity && typeof remoteExecutionIdentity.remoteCwd === "string"
      ? remoteExecutionIdentity.remoteCwd
      : cwd;
  const executionTargetIsRemote = remoteExecutionIdentity !== null;
  const shapedWorkspaceEnv = shapePaperclipWorkspaceEnvForExecution({
    workspaceCwd: effectiveWorkspaceCwd,
    workspaceWorktreePath,
    executionTargetIsRemote,
    executionCwd: effectiveExecutionCwd,
  });
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  const acpxAgent = normalizeAgent(config);
  const mode = normalizeMode(config);
  const permissionMode = normalizePermissionMode(config);
  const nonInteractivePermissions = normalizeNonInteractivePermissions(config);
  const requestedModel = asString(config.model, "").trim();
  const requestedThinkingEffort = normalizeRequestedThinkingEffort(config);
  const fastMode = acpxAgent === "codex" && config.fastMode === true;
  // Resolve the wall-clock timeout through the shared execution-target
  // resolver so sandbox-backed runs pick up the 4h backstop default while
  // local/SSH runs keep the historical "0 = no adapter timeout" behavior.
  const timeoutResolution = resolveAdapterExecutionTargetTimeout(
    executionTarget,
    asNumber(config.timeoutSec, DEFAULT_ACP_ENGINE_TIMEOUT_SEC),
  );
  const timeoutSec = timeoutResolution.timeoutSec;
  const stateDir = path.resolve(asString(config.stateDir, "") || defaultStateDir(agent.companyId, agent.id));
  await fs.mkdir(stateDir, { recursive: true });

  const envConfig = parseObject(config.env);
  const hasExplicitApiKey =
    typeof envConfig.PAPERCLIP_API_KEY === "string" && envConfig.PAPERCLIP_API_KEY.trim().length > 0;
  const env: Record<string, string> = { ...buildPaperclipEnv(agent), PAPERCLIP_RUN_ID: runId };
  const wakeTaskId =
    (typeof context.taskId === "string" && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim()) ||
    "";
  const wakeReason = typeof context.wakeReason === "string" ? context.wakeReason.trim() : "";
  const wakeCommentId =
    (typeof context.wakeCommentId === "string" && context.wakeCommentId.trim()) ||
    (typeof context.commentId === "string" && context.commentId.trim()) ||
    "";
  const approvalId = typeof context.approvalId === "string" ? context.approvalId.trim() : "";
  const approvalStatus = typeof context.approvalStatus === "string" ? context.approvalStatus.trim() : "";
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const wakePayloadJson = stringifyPaperclipWakePayload(context.paperclipWake);
  const issueWorkMode = readPaperclipIssueWorkModeFromContext(context);
  if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;
  if (issueWorkMode) env.PAPERCLIP_ISSUE_WORK_MODE = issueWorkMode;
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  if (approvalId) env.PAPERCLIP_APPROVAL_ID = approvalId;
  if (approvalStatus) env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  if (linkedIssueIds.length > 0) env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  if (wakePayloadJson) env.PAPERCLIP_WAKE_PAYLOAD_JSON = wakePayloadJson;
  applyPaperclipWorkspaceEnv(env, {
    workspaceCwd: shapedWorkspaceEnv.workspaceCwd,
    workspaceSource,
    workspaceStrategy,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    workspaceBranch,
    workspaceWorktreePath: shapedWorkspaceEnv.workspaceWorktreePath,
    agentHome,
  });
  const shapedEnvConfig = rewriteWorkspaceCwdEnvVarsForExecution({
    env: envConfig,
    workspaceCwd: effectiveWorkspaceCwd,
    executionCwd: shapedWorkspaceEnv.workspaceCwd,
    executionTargetIsRemote,
  });
  for (const [key, value] of Object.entries(shapedEnvConfig)) {
    if (typeof value === "string") env[key] = value;
  }
  if (!hasExplicitApiKey && authToken) env.PAPERCLIP_API_KEY = authToken;
  // For the claude agent, set model via ANTHROPIC_MODEL at startup rather than
  // via session/set_config_option — the ACP server's set_config_option handler
  // validates the value against its internal available-models list and rejects
  // bare model IDs (e.g. "claude-opus-4-7") that don't exactly match a model
  // entry in some versions. ANTHROPIC_MODEL is read during initialization, so
  // it reliably sets the model before any turns are run.
  if (requestedModel && acpxAgent === "claude" && !env.ANTHROPIC_MODEL) {
    env.ANTHROPIC_MODEL = requestedModel;
  }

  let skillPromptInstructions = "";
  let skillsIdentity: Record<string, unknown> = { mode: "unsupported" };
  const skillCommandNotes: string[] = [];
  let paperclipClaudeSettings: PaperclipClaudeSettingsResult | null = null;
  if (acpxAgent === "claude") {
    const preparedSkills = await prepareClaudeSkillRuntime({
      stateDir,
      config,
      moduleDir: input.engine.moduleDir,
      onLog: input.ctx.onLog,
    });
    skillPromptInstructions = preparedSkills.promptInstructions;
    skillsIdentity = preparedSkills.identity;
    skillCommandNotes.push(...preparedSkills.commandNotes);
    paperclipClaudeSettings = await writePaperclipClaudeSettings({
      cwd,
      stateDir,
      agentHome,
      companyId: agent.companyId,
    });
    skillCommandNotes.push(
      `Wrote Paperclip-managed Claude settings to ${paperclipClaudeSettings.filePath} (defaultMode=${paperclipClaudeSettings.defaultMode}${
        paperclipClaudeSettings.overrodeDontAsk ? "; overrode user dontAsk" : ""
      }, +${paperclipClaudeSettings.additionalDirectories.length} read root(s), +${paperclipClaudeSettings.allow.length} allow rule(s)).`,
    );
  } else if (acpxAgent === "codex") {
    const preparedSkills = await prepareCodexSkillRuntime({
      companyId: agent.companyId,
      config,
      env,
      moduleDir: input.engine.moduleDir,
      onLog: input.ctx.onLog,
    });
    skillsIdentity = preparedSkills.identity;
    skillCommandNotes.push(...preparedSkills.commandNotes);
  } else if (acpxAgent === "gemini") {
    const preparedSkills = await prepareGeminiSkillRuntime({
      config,
      moduleDir: input.engine.moduleDir,
      onLog: input.ctx.onLog,
    });
    skillsIdentity = preparedSkills.identity;
    skillCommandNotes.push(...preparedSkills.commandNotes);
  } else {
    const desired = resolvePaperclipDesiredSkillNames(
      config,
      await readPaperclipRuntimeSkillEntries(config, input.engine.moduleDir),
    );
    skillsIdentity = { mode: "custom_unsupported", desiredSkillNames: desired };
    if (desired.length > 0) {
      skillCommandNotes.push("Selected Paperclip skills are tracked only; ACPX custom commands do not expose a runtime skill contract yet.");
    }
  }

  const configuredCommand = asString(config.agentCommand, "").trim();
  const builtInCommand = await resolveBuiltInAgentCommand(acpxAgent, input.engine.packageRootDir);
  let agentCommand = configuredCommand || builtInCommand?.command || null;
  let agentCommandShell = configuredCommand || builtInCommand?.shellCommand || "";
  if (acpxAgent === "gemini" && agentCommandShell) {
    const normalized = await normalizeGeminiAcpCommandShell(
      agentCommandShell,
      ensurePathInEnv({ ...process.env, ...env }),
    );
    if (normalized !== agentCommandShell) {
      agentCommandShell = normalized;
      agentCommand = normalized;
    }
  }
  const childStderrDir = path.join(stateDir, "run-stderr");
  const childStderrLogPath = agentCommand ? path.join(childStderrDir, `${runId}.log`) : null;
  const taskKey = asString(input.ctx.runtime.taskKey, "") || wakeTaskId || workspaceId || "default";
  const wrapper = agentCommand
    ? await writeAgentWrapper({
        stateDir,
        acpxAgent,
        agentCommandShell,
        env,
        childStderrDir,
        cwd,
        taskKey,
      })
    : null;
  const wrapperPath = wrapper?.wrapperPath ?? null;
  const overrides = wrapperPath ? { [acpxAgent]: wrapperPath } : undefined;
  const agentRegistry = createAgentRegistry({ overrides });
  const fingerprint = shortHash({
    acpxAgent,
    agentCommand: agentCommand ?? acpxAgent,
    cwd: path.resolve(cwd),
    mode,
    permissionMode,
    nonInteractivePermissions,
    requestedModel,
    requestedThinkingEffort,
    fastMode,
    remoteExecutionIdentity,
    skillsIdentity,
    skillPromptInstructions,
    paperclipClaudeSettings: paperclipClaudeSettings
      ? {
          allow: paperclipClaudeSettings.allow,
          additionalDirectories: paperclipClaudeSettings.additionalDirectories,
          defaultMode: paperclipClaudeSettings.defaultMode,
        }
      : null,
    secretManifestHash: shortHash(secretManifest),
  });
  const sessionKey = `paperclip:${agent.companyId}:${agent.id}:${taskKey}:${fingerprint}`;
  if (wrapper) {
    // The session record persists the wrapper path ACPX respawns. Restore it
    // when it points somewhere this run did not write (a swept file, or a
    // record created before the stable-path layout) so the respawn finds a
    // usable wrapper instead of failing with ENOENT, and so it runs with this
    // run's credentials rather than the previous run's.
    await materializeSessionWrapper({
      stateDir,
      sessionKey,
      wrapperPath: wrapper.wrapperPath,
      script: wrapper.script,
    });
  }
  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  const loggedEnv = buildInvocationEnvForLogs(env, {
    runtimeEnv,
    includeRuntimeKeys: ["HOME"],
    resolvedCommand: wrapperPath ?? agentCommand ?? acpxAgent,
  });

  return {
    acpxAgent,
    mode,
    cwd,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    env,
    loggedEnv,
    stateDir,
    permissionMode,
    nonInteractivePermissions,
    requestedModel,
    requestedThinkingEffort,
    fastMode,
    timeoutSec,
    timeoutResolution,
    sessionKey,
    fingerprint,
    agentCommand,
    agentRegistry,
    remoteExecutionIdentity,
    skillPromptInstructions,
    skillsIdentity: {
      ...skillsIdentity,
      commandNotes: skillCommandNotes,
    },
    childStderrLogPath,
    paperclipClaudeSettings,
  };
}

function sessionConfigOptions(prepared: AcpxPreparedRuntime): Array<{ key: string; value: string }> {
  const options: Array<{ key: string; value: string }> = [];
  // Model for the claude agent is pre-set via ANTHROPIC_MODEL env var at
  // startup; skip set_config_option to avoid ACP-server model-name validation
  // that rejects bare IDs like "claude-opus-4-7" in some runtime versions.
  if (prepared.requestedModel && prepared.acpxAgent !== "claude") {
    options.push({ key: "model", value: prepared.requestedModel });
  }
  if (prepared.requestedThinkingEffort) {
    options.push({
      key: prepared.acpxAgent === "codex" ? "reasoning_effort" : "effort",
      value: prepared.requestedThinkingEffort,
    });
  }
  if (prepared.fastMode) {
    options.push(
      { key: "service_tier", value: "fast" },
      { key: "features.fast_mode", value: "true" },
    );
  }
  return options;
}

async function applySessionConfigOptions(input: {
  runtime: AcpRuntime;
  handle: AcpRuntimeHandle;
  prepared: AcpxPreparedRuntime;
  onLog: AdapterExecutionContext["onLog"];
}) {
  const options = sessionConfigOptions(input.prepared);
  if (options.length === 0) return;
  if (!input.runtime.setConfigOption) {
    const message =
      "ACPX runtime does not expose session config controls; upgrade ACPX or remove configured model, effort, and fast mode overrides.";
    await input.onLog("stderr", `[paperclip] ${message}\n`);
    throw new Error(message);
  }
  for (const option of options) {
    await input.runtime.setConfigOption({
      handle: input.handle,
      key: option.key,
      value: option.value,
    });
    await input.onLog(
      "stdout",
      `[paperclip] Applied ACPX ${input.prepared.acpxAgent} config ${option.key}=${option.value}\n`,
    );
  }
}

function renderPaperclipEnvNote(env: Record<string, string>): string {
  const paperclipKeys = Object.keys(env)
    .filter((key) => key.startsWith("PAPERCLIP_"))
    .sort();
  if (paperclipKeys.length === 0) return "";
  return [
    "Paperclip runtime note:",
    `The following PAPERCLIP_* environment variables are available in this run: ${paperclipKeys.join(", ")}`,
    "Do not assume these variables are missing without checking your shell environment.",
  ].join("\n");
}

function renderApiAccessNote(env: Record<string, string>): string {
  if (!env.PAPERCLIP_API_URL || !env.PAPERCLIP_API_KEY) return "";
  const lines = [
    "Paperclip API access note:",
    "Use terminal commands with curl to make Paperclip API requests.",
    "Normalize the base URL before adding API paths:",
    `  PAPERCLIP_API_BASE="\${PAPERCLIP_API_URL%/}"; PAPERCLIP_API_BASE="\${PAPERCLIP_API_BASE%/api}"`,
    "GET example:",
    `  curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" "$PAPERCLIP_API_BASE/api/agents/me"`,
  ];
  if (env.PAPERCLIP_TASK_ID) {
    lines.push(
      "Scoped issue comment example:",
      `  curl -s -X POST -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "Content-Type: application/json" -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" -d '{"body":"Status update from agent."}' "$PAPERCLIP_API_BASE/api/issues/$PAPERCLIP_TASK_ID/comments"`,
    );
  } else {
    lines.push("Use a real issue id from the current context before making issue write requests.");
  }
  return lines.join("\n");
}

async function buildPrompt(ctx: AdapterExecutionContext, resumedSession: boolean, env: Record<string, string>): Promise<{
  prompt: string;
  promptMetrics: Record<string, number>;
  commandNotes: string[];
}> {
  const { agent, runId, config, context, onLog } = ctx;
  const promptTemplate = asString(config.promptTemplate, DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE);
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const instructionsDir = instructionsFilePath ? `${path.dirname(instructionsFilePath)}/` : "";
  let instructionsPrefix = "";
  const commandNotes: string[] = [];
  if (instructionsFilePath) {
    try {
      const instructionsContents = await fs.readFile(instructionsFilePath, "utf8");
      instructionsPrefix =
        `${instructionsContents}\n\n` +
        `The above agent instructions were loaded from ${instructionsFilePath}. ` +
        `Resolve any relative file references from ${instructionsDir}.\n\n`;
      commandNotes.push(
        `Loaded agent instructions from ${instructionsFilePath}`,
        `Prepended instructions + path directive to the ACPX prompt (relative references from ${instructionsDir}).`,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await onLog(
        "stderr",
        `[paperclip] Warning: could not read agent instructions file "${instructionsFilePath}": ${reason}\n`,
      );
      commandNotes.push(`Configured instructionsFilePath ${instructionsFilePath}, but file could not be read.`);
    }
  }

  const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, "");
  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };
  const renderedBootstrapPrompt =
    !resumedSession && bootstrapPromptTemplate.trim().length > 0
      ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
      : "";
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, { resumedSession });
  const shouldUseResumeDeltaPrompt = resumedSession && wakePrompt.length > 0;
  const promptInstructionsPrefix = shouldUseResumeDeltaPrompt ? "" : instructionsPrefix;
  const renderedPrompt = shouldUseResumeDeltaPrompt ? "" : renderTemplate(promptTemplate, templateData);
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  const taskContextNote = asString(context.paperclipTaskMarkdown, "").trim();
  const paperclipEnvNote = renderPaperclipEnvNote(env);
  const apiAccessNote = renderApiAccessNote(env);
  const prompt = joinPromptSections([
    promptInstructionsPrefix,
    renderedBootstrapPrompt,
    wakePrompt,
    sessionHandoffNote,
    taskContextNote,
    paperclipEnvNote,
    apiAccessNote,
    renderedPrompt,
  ]);

  return {
    prompt,
    commandNotes,
    promptMetrics: {
      promptChars: prompt.length,
      instructionsChars: promptInstructionsPrefix.length,
      bootstrapPromptChars: renderedBootstrapPrompt.length,
      wakePromptChars: wakePrompt.length,
      sessionHandoffChars: sessionHandoffNote.length,
      taskContextChars: taskContextNote.length,
      runtimeNoteChars: paperclipEnvNote.length + apiAccessNote.length,
      heartbeatPromptChars: renderedPrompt.length,
    },
  };
}

async function emitAcpxLog(ctx: AdapterExecutionContext, payload: Record<string, unknown>) {
  await ctx.onLog("stdout", `${JSON.stringify(payload)}\n`);
}

async function emitRuntimeEvent(ctx: AdapterExecutionContext, event: AcpRuntimeEvent) {
  if (event.type === "text_delta") {
    await emitAcpxLog(ctx, {
      type: "acpx.text_delta",
      text: event.text,
      channel: event.stream === "thought" ? "thought" : "output",
      tag: event.tag,
    });
    return;
  }
  if (event.type === "tool_call") {
    const eventRecord = event as Record<string, unknown>;
    const toolInput = eventRecord.input;
    await emitAcpxLog(ctx, {
      type: "acpx.tool_call",
      name: event.title ?? "acp_tool",
      toolCallId: event.toolCallId,
      status: event.status,
      text: event.text,
      tag: event.tag,
      ...(toolInput !== undefined ? { input: toolInput } : {}),
    });
    return;
  }
  if (event.type === "status") {
    await emitAcpxLog(ctx, {
      type: "acpx.status",
      text: event.text,
      tag: event.tag,
      used: event.used,
      size: event.size,
    });
    return;
  }
  if (event.type === "done") {
    await emitAcpxLog(ctx, {
      type: "acpx.result",
      summary: event.stopReason ?? "completed",
      stopReason: event.stopReason,
    });
    return;
  }
  if (event.type === "error") {
    await emitAcpxLog(ctx, {
      type: "acpx.error",
      message: event.message,
      code: event.code,
      retryable: event.retryable,
    });
  }
}

function resultErrorMessage(result: AcpRuntimeTurnResult): string | null {
  if (result.status !== "failed") return null;
  return result.error.message;
}

type AcpxExecutionPhase = "ensure_session" | "configure_session" | "turn";

function describeErrorDiagnostics(err: unknown): {
  errorName: string;
  acpCode: string | null;
  causeMessage: string | null;
  retryable: boolean | null;
  stackPreview: string | null;
} {
  const errorName =
    err instanceof Error ? err.name || err.constructor.name : typeof err;
  const maybeCode =
    err && typeof err === "object" && typeof (err as { code?: unknown }).code === "string"
      ? (err as { code: string }).code
      : null;
  const acpCode =
    isAcpRuntimeError(err) || (maybeCode?.startsWith("ACP_") ?? false) ? maybeCode : null;
  const cause =
    err && typeof err === "object" && (err as { cause?: unknown }).cause !== undefined
      ? (err as { cause?: unknown }).cause
      : undefined;
  const causeMessage =
    cause instanceof Error
      ? cause.message
      : typeof cause === "string"
        ? cause
        : null;
  const retryable =
    err && typeof err === "object" && typeof (err as { retryable?: unknown }).retryable === "boolean"
      ? (err as { retryable: boolean }).retryable
      : null;
  const stack = err instanceof Error && typeof err.stack === "string" ? err.stack : "";
  const stackPreview = stack ? stack.split("\n").slice(0, 6).join("\n") : null;
  return { errorName, acpCode, causeMessage, retryable, stackPreview };
}

function classifyError(
  err: unknown,
  phase?: AcpxExecutionPhase,
): Pick<AdapterExecutionResult, "errorCode" | "errorFamily" | "errorMeta"> {
  const message = err instanceof Error ? err.message : String(err);
  const diagnostics = describeErrorDiagnostics(err);
  const { acpCode, errorName, causeMessage, retryable, stackPreview } = diagnostics;
  const baseMeta: Record<string, unknown> = {
    errorName,
    ...(acpCode ? { acpCode } : {}),
    ...(causeMessage ? { causeMessage } : {}),
    ...(retryable !== null ? { retryable } : {}),
    ...(stackPreview ? { stackPreview } : {}),
    ...(phase ? { phase } : {}),
  };
  const lower = message.toLowerCase();
  const authLike = lower.includes("auth") || lower.includes("login") || lower.includes("credential");
  if (authLike) {
    return {
      errorCode: "acpx_auth_required",
      errorFamily: null,
      errorMeta: { category: "auth", ...baseMeta },
    };
  }
  // An upstream transport interruption (dropped SSE stream, reset socket) is a
  // transient fault, not a deterministic protocol error. Classify it as such so
  // the heartbeat schedules a bounded retry instead of killing the run.
  // A context-window overflow is checked BEFORE the transport family. It is
  // an upstream refusal, but a retry that replays the same accumulated
  // context dies identically - so it needs its own code and its own
  // (re-seeding) retry path.
  const contextOverflow =
    classifyContextWindowOverflowFailure(message) ??
    classifyContextWindowOverflowFailure(causeMessage) ??
    null;
  if (contextOverflow) {
    return {
      errorCode: contextOverflow.errorCode,
      errorFamily: contextOverflow.errorFamily,
      errorMeta: { category: "context_overflow", ...baseMeta },
    };
  }
  const transientUpstream =
    classifyTransientUpstreamFailure(message) ??
    classifyTransientUpstreamFailure(causeMessage) ??
    null;
  if (transientUpstream) {
    return {
      errorCode: transientUpstream.errorCode,
      errorFamily: transientUpstream.errorFamily,
      errorMeta: { category: "transient", ...baseMeta },
    };
  }
  const phaseCode = (() => {
    if (acpCode === "ACP_SESSION_INIT_FAILED") return "acpx_session_init_failed";
    if (acpCode === "ACP_TURN_FAILED") return "acpx_turn_failed";
    if (acpCode === "ACP_BACKEND_MISSING") return "acpx_backend_missing";
    if (acpCode === "ACP_BACKEND_UNAVAILABLE") return "acpx_backend_unavailable";
    if (phase === "ensure_session") return "acpx_session_init_failed";
    if (phase === "configure_session") return "acpx_session_config_failed";
    if (phase === "turn") return "acpx_turn_failed";
    return null;
  })();
  if (phaseCode) {
    return {
      errorCode: phaseCode,
      errorFamily: null,
      errorMeta: { category: acpCode ? "protocol" : "runtime", ...baseMeta },
    };
  }
  if (acpCode) {
    return {
      errorCode: "acpx_protocol_error",
      errorFamily: null,
      errorMeta: { category: "protocol", ...baseMeta },
    };
  }
  return {
    errorCode: "acpx_runtime_error",
    errorFamily: null,
    errorMeta: { category: "runtime", ...baseMeta },
  };
}

async function readChildStderrTail(input: {
  logPath: string | null;
  maxBytes?: number;
}): Promise<string | null> {
  if (!input.logPath) return null;
  const maxBytes = input.maxBytes ?? 4096;
  let handle: fs.FileHandle | null = null;
  try {
    const stat = await fs.stat(input.logPath);
    if (stat.size === 0) return null;
    handle = await fs.open(input.logPath, "r");
    const readBytes = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(readBytes);
    await handle.read(buffer, 0, readBytes, Math.max(0, stat.size - readBytes));
    const tail = buffer.toString("utf8").trim();
    return tail.length > 0 ? tail : null;
  } catch {
    return null;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function emitAcpxFailure(input: {
  ctx: AdapterExecutionContext;
  prepared: AcpxPreparedRuntime;
  err: unknown;
  phase: AcpxExecutionPhase;
  // Replace the err-derived message in both the stderr-tail log header and the
  // acpx.error payload. Used by the turn path to surface the self-describing
  // adapter execution timeout message instead of the raw underlying error.
  messageOverride?: string;
}): Promise<{
  classified: Pick<AdapterExecutionResult, "errorCode" | "errorFamily" | "errorMeta">;
  message: string;
  childStderrTail: string | null;
}> {
  const { ctx, prepared, err, phase, messageOverride } = input;
  const rawMessage = err instanceof Error ? err.message : String(err);
  const message = messageOverride ?? rawMessage;
  const classified = classifyError(err, phase);
  const childStderrTail = await readChildStderrTail({ logPath: prepared.childStderrLogPath });
  if (childStderrTail) {
    await ctx.onLog(
      "stderr",
      `[paperclip] ACPX child stderr tail (${phase}):\n${childStderrTail}\n`,
    );
  }
  await emitAcpxLog(ctx, {
    type: "acpx.error",
    message,
    phase,
    ...classified.errorMeta,
    ...(childStderrTail ? { childStderrTail } : {}),
  });
  return { classified, message, childStderrTail };
}

function isResumeFailure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /resume|load|not found|no session|unknown session|conversation/i.test(message);
}

async function cleanupIdleHandles(input: {
  handles: Map<string, RuntimeCacheEntry>;
  now: number;
  idleMs: number;
}) {
  if (input.idleMs <= 0) return;

  const stale: Array<[string, RuntimeCacheEntry]> = [];
  for (const entry of input.handles.entries()) {
    if (input.now - entry[1].lastUsedAt >= input.idleMs) stale.push(entry);
  }
  for (const [key, entry] of stale) {
    await closeWarmHandle({
      handles: input.handles,
      key,
      entry,
      reason: "paperclip idle cleanup",
    });
  }
}

function clearWarmHandleTimer(entry: RuntimeCacheEntry) {
  if (!entry.cleanupTimer) return;
  clearTimeout(entry.cleanupTimer);
  entry.cleanupTimer = undefined;
}

async function closeWarmHandle(input: {
  handles: Map<string, RuntimeCacheEntry>;
  key: string;
  entry: RuntimeCacheEntry;
  reason: string;
  discardPersistentState?: boolean;
}) {
  if (input.handles.get(input.key) === input.entry) {
    input.handles.delete(input.key);
  }
  clearWarmHandleTimer(input.entry);
  await input.entry.runtime.close({
    handle: input.entry.handle,
    reason: input.reason,
    discardPersistentState: input.discardPersistentState ?? false,
  }).catch(() => {});
}

function scheduleIdleHandleCleanup(input: {
  handles: Map<string, RuntimeCacheEntry>;
  key: string;
  entry: RuntimeCacheEntry;
  idleMs: number;
  now: () => number;
}) {
  clearWarmHandleTimer(input.entry);
  if (input.idleMs <= 0) return;

  const delayMs = Math.max(1, input.entry.lastUsedAt + input.idleMs - input.now());
  input.entry.cleanupTimer = setTimeout(() => {
    void (async () => {
      const current = input.handles.get(input.key);
      if (current !== input.entry) return;
      const idleForMs = input.now() - input.entry.lastUsedAt;
      if (idleForMs < input.idleMs) {
        scheduleIdleHandleCleanup(input);
        return;
      }
      await closeWarmHandle({
        handles: input.handles,
        key: input.key,
        entry: input.entry,
        reason: "paperclip idle cleanup",
      });
    })();
  }, delayMs);
  input.entry.cleanupTimer.unref?.();
}

function warmHandleMatches(
  entry: RuntimeCacheEntry | undefined,
  runtime: AcpRuntime,
  handle: AcpRuntimeHandle,
): boolean {
  return entry !== undefined && entry.runtime === runtime && entry.handle === handle;
}

export function createAcpxEngineExecutor(deps: AcpxEngineExecutorOptions = {}) {
  const createRuntime = deps.createRuntime ?? createAcpRuntime;
  const now = deps.now ?? (() => Date.now());
  const warmHandles = deps.warmHandles ?? defaultWarmHandles;
  const engine = resolveEngineSettings(deps);

  return async function executeAcpxEngine(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
    const prepared = await buildRuntime({ ctx, engine });
    // State the effective wall-clock timeout and its source up front so a
    // later timeout is diagnosable from the run log alone. Goes to stderr:
    // the acpx stdout log stream carries JSON acpx.* event payloads and must
    // stay machine-parseable line by line.
    await ctx.onLog(
      "stderr",
      `[paperclip] ${formatAdapterExecutionTimeoutStartLogLine(prepared.timeoutResolution)}\n`,
    );
    const warmIdleMs = asNumber(ctx.config.warmHandleIdleMs, DEFAULT_ACP_ENGINE_WARM_HANDLE_IDLE_MS);
    await cleanupIdleHandles({ handles: warmHandles, now: now(), idleMs: warmIdleMs });

    const previousParams = parseObject(ctx.runtime.sessionParams);
    const canResume = isCompatibleSession(previousParams, prepared);
    const resumeSessionId = canResume ? asString(previousParams.acpSessionId, "") || undefined : undefined;
    const cached = canResume ? warmHandles.get(prepared.sessionKey) : undefined;
    const runtimeOptions: AcpRuntimeOptions = {
      cwd: prepared.cwd,
      sessionStore: createRuntimeStore({ stateDir: prepared.stateDir }),
      agentRegistry: prepared.agentRegistry,
      permissionMode: prepared.permissionMode,
      nonInteractivePermissions: prepared.nonInteractivePermissions,
      timeoutMs: prepared.timeoutSec > 0 ? prepared.timeoutSec * 1000 : undefined,
      // Scope ACPX runtime verbose logs to the claude agent only. Codex
      // and custom agents already emit their own per-tool output and don't
      // benefit from doubling the log volume.
      verbose: prepared.acpxAgent === "claude",
    };
    const runtime = cached?.runtime ?? createRuntime(runtimeOptions);
    if (cached) clearWarmHandleTimer(cached);
    if (!canResume && asString(previousParams.runtimeSessionName, "")) {
      await ctx.onLog(
        "stdout",
        `[paperclip] ACPX session "${asString(previousParams.runtimeSessionName, "")}" does not match the current agent/cwd/mode/runtime identity; starting fresh in "${prepared.cwd}".\n`,
      );
    }

    let handle = cached?.handle ?? null;
    let resumedSession = Boolean(handle ?? resumeSessionId);
    let clearSession = false;

    try {
      if (!handle) {
        try {
          handle = await runtime.ensureSession({
            sessionKey: prepared.sessionKey,
            agent: prepared.acpxAgent,
            mode: prepared.mode,
            cwd: prepared.cwd,
            resumeSessionId,
          });
        } catch (err) {
          if (!resumeSessionId || !isResumeFailure(err)) throw err;
          clearSession = true;
          resumedSession = false;
          await ctx.onLog(
            "stdout",
            `[paperclip] ACPX resume session "${resumeSessionId}" is unavailable; retrying with a fresh session.\n`,
          );
          handle = await runtime.ensureSession({
            sessionKey: prepared.sessionKey,
            agent: prepared.acpxAgent,
            mode: prepared.mode,
            cwd: prepared.cwd,
          });
        }
      }
    } catch (err) {
      const { classified, message } = await emitAcpxFailure({
        ctx,
        prepared,
        err,
        phase: "ensure_session",
      });
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: message,
        ...classified,
        provider: "acpx",
        model: prepared.requestedModel || null,
        clearSession,
        resultJson: { phase: "ensure_session" },
        summary: message,
      };
    }

    if (!handle) {
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: "ACPX did not return a runtime session handle.",
        errorCode: "acpx_runtime_error",
        provider: "acpx",
        model: prepared.requestedModel || null,
        resultJson: { phase: "ensure_session" },
        summary: "ACPX did not return a runtime session handle.",
      };
    }
    const sessionHandle = handle;
    try {
      await applySessionConfigOptions({
        runtime,
        handle: sessionHandle,
        prepared,
        onLog: ctx.onLog,
      });
    } catch (err) {
      const { classified, message } = await emitAcpxFailure({
        ctx,
        prepared,
        err,
        phase: "configure_session",
      });
      await runtime.close({
        handle: sessionHandle,
        reason: "paperclip config cleanup",
        discardPersistentState: false,
      }).catch(() => {});
      const existing = warmHandles.get(prepared.sessionKey);
      if (warmHandleMatches(existing, runtime, sessionHandle) && existing) {
        clearWarmHandleTimer(existing);
        warmHandles.delete(prepared.sessionKey);
      }
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: message,
        ...classified,
        provider: "acpx",
        model: prepared.requestedModel || null,
        clearSession,
        resultJson: {
          phase: "configure_session",
          agent: prepared.acpxAgent,
          requestedModel: prepared.requestedModel || null,
          requestedThinkingEffort: prepared.requestedThinkingEffort || null,
          fastMode: prepared.fastMode,
        },
        summary: message,
      };
    }
    const { prompt, promptMetrics, commandNotes } = await buildPrompt(ctx, resumedSession, prepared.env);
    const runPrompt = joinPromptSections([prepared.skillPromptInstructions, prompt]);
    await emitAcpxLog(ctx, {
      type: "acpx.session",
      agent: prepared.acpxAgent,
      sessionId: sessionHandle.backendSessionId,
      acpSessionId: sessionHandle.backendSessionId,
      agentSessionId: sessionHandle.agentSessionId,
      runtimeSessionName: sessionHandle.runtimeSessionName,
      mode: prepared.mode,
      permissionMode: prepared.permissionMode,
      model: prepared.requestedModel || null,
      thinkingEffort: prepared.requestedThinkingEffort || null,
      fastMode: prepared.fastMode,
    });
    if (ctx.onMeta) {
      await ctx.onMeta({
        adapterType: engine.adapterType,
        command: prepared.agentCommand ?? prepared.acpxAgent,
        cwd: prepared.cwd,
        commandNotes: [
          `ACPX runtime embedded in Paperclip with ${prepared.mode} session mode.`,
          `Effective ACPX permission mode: ${prepared.permissionMode}.`,
          ...(prepared.requestedModel
            ? [
                prepared.acpxAgent === "claude"
                  ? `Requested ACPX model: ${prepared.requestedModel} (set via ANTHROPIC_MODEL env at startup).`
                  : `Requested ACPX model: ${prepared.requestedModel}.`,
              ]
            : []),
          ...(prepared.requestedThinkingEffort ? [`Requested ACPX thinking effort: ${prepared.requestedThinkingEffort}.`] : []),
          ...(prepared.fastMode ? ["Requested ACPX Codex fast mode."] : []),
          ...(Array.isArray(prepared.skillsIdentity.commandNotes)
            ? prepared.skillsIdentity.commandNotes.filter((note): note is string => typeof note === "string")
            : []),
          ...commandNotes,
        ],
        env: prepared.loggedEnv,
        prompt: runPrompt,
        promptMetrics,
        context: ctx.context,
      });
    }

    let cancelActiveTurn: ((reason: string) => Promise<void>) | null = null;
    let controller: AbortController | null = null;
    let timeout: NodeJS.Timeout | null = null;
    let timedOut = false;
    const textParts: string[] = [];
    try {
      const timeoutMs = prepared.timeoutSec > 0 ? prepared.timeoutSec * 1000 : undefined;
      controller = new AbortController();
      if (timeoutMs) {
        timeout = setTimeout(() => {
          timedOut = true;
          controller?.abort();
          void cancelActiveTurn?.(formatAdapterExecutionTimeoutErrorMessage(prepared.timeoutResolution)).catch(() => {});
        }, timeoutMs);
      }
      const turn = runtime.startTurn({
        handle: sessionHandle,
        text: runPrompt,
        mode: "prompt",
        requestId: ctx.runId,
        timeoutMs,
        signal: controller?.signal,
      });
      cancelActiveTurn = async (reason: string) => {
        await turn.cancel({ reason });
      };
      // TON-1001: bound the ATTEMPT, not just the prompt. A single long
      // attempt grows its own ACP transcript until the provider refuses the
      // next request with "context window exceeds limit (2013)" - the same
      // refusal an oversized prompt produces. Track the transcript as the
      // attempt works and stop BEFORE the provider refuses, so the run ends
      // in a retryable stop with its partial progress intact.
      const transcriptBudgetChars = asNumber(
        ctx.config.transcriptBudgetChars,
        DEFAULT_TRANSCRIPT_BUDGET_CHARS,
      );
      const contextUsageStopRatio = asNumber(
        ctx.config.contextUsageStopRatio,
        DEFAULT_CONTEXT_USAGE_STOP_RATIO,
      );
      let transcriptChars = 0;
      let usageSample: ContextUsageSample | null = null;
      let transcriptStop: TranscriptStop | null = null;
      for await (const event of turn.events) {
        if (event.type === "text_delta") textParts.push(event.text);
        transcriptChars += measureTranscriptEventChars(event);
        if (event.type === "status") {
          const sample = readContextUsageSample({
            tag: event.tag ?? null,
            used: event.used ?? null,
            size: event.size ?? null,
          });
          if (sample) usageSample = mergeContextUsageSample(usageSample, sample);
        }
        await emitRuntimeEvent(ctx, event);
        const decision = evaluateTranscriptBudget({
          transcriptChars,
          transcriptBudgetChars,
          usage: usageSample,
          usageRatio: contextUsageStopRatio,
        });
        if (decision.stop && decision.reason) {
          transcriptStop = buildTranscriptStop({
            transcriptChars,
            reason: decision.reason,
            transcriptBudgetChars,
            usage: usageSample,
            usageRatio: contextUsageStopRatio,
          });
          break;
        }
      }
      if (transcriptStop) {
        // Cancel the turn so the attempt ends HERE, with a fresh session for
        // the retry, instead of dying mid-flight with a 2013.
        await cancelActiveTurn?.(transcriptStop.message).catch(() => {});
      }
      const terminal = await turn.result;
      if (timeout) clearTimeout(timeout);
      // Detect a context-window overflow as soon as the turn result is known:
      // the cleanup below must DISCARD the persisted ACP session state, or the
      // next retry resumes the very conversation that overflowed the window.
      const terminalContextOverflow =
        terminal.status === "failed"
          ? classifyContextWindowOverflowFailure(terminal.error?.message)
          : null;
      if (terminal.status === "failed" || terminal.status === "cancelled" || timedOut) {
        const existing = warmHandles.get(prepared.sessionKey);
        if (warmHandleMatches(existing, runtime, sessionHandle) && existing) {
          await closeWarmHandle({
            handles: warmHandles,
            key: prepared.sessionKey,
            entry: existing,
            reason: timedOut ? "paperclip timeout cleanup" : `paperclip turn ${terminal.status}`,
            discardPersistentState:
              terminal.status === "cancelled" || timedOut || Boolean(terminalContextOverflow),
          });
        } else {
          await runtime.close({
            handle: sessionHandle,
            reason: timedOut ? "paperclip timeout cleanup" : `paperclip turn ${terminal.status}`,
            discardPersistentState:
              terminal.status === "cancelled" || timedOut || Boolean(terminalContextOverflow),
          }).catch(() => {});
        }
      } else if (prepared.mode === "persistent" && warmIdleMs > 0) {
        const existing = warmHandles.get(prepared.sessionKey);
        if (existing && !warmHandleMatches(existing, runtime, sessionHandle)) {
          await runtime.close({
            handle: sessionHandle,
            reason: "paperclip duplicate warm handle cleanup",
            discardPersistentState: false,
          }).catch(() => {});
        } else {
          const entry: RuntimeCacheEntry = {
            runtime,
            handle: sessionHandle,
            fingerprint: prepared.fingerprint,
            lastUsedAt: now(),
          };
          warmHandles.set(prepared.sessionKey, entry);
          scheduleIdleHandleCleanup({
            handles: warmHandles,
            key: prepared.sessionKey,
            entry,
            idleMs: warmIdleMs,
            now,
          });
        }
      } else {
        const existing = warmHandles.get(prepared.sessionKey);
        if (warmHandleMatches(existing, runtime, sessionHandle) && existing) {
          await closeWarmHandle({
            handles: warmHandles,
            key: prepared.sessionKey,
            entry: existing,
            reason: "paperclip completed turn cleanup",
          });
        } else {
          await runtime.close({
            handle: sessionHandle,
            reason: "paperclip completed turn cleanup",
            discardPersistentState: false,
          }).catch(() => {});
        }
      }

      const errorMessage = timedOut
        ? formatAdapterExecutionTimeoutErrorMessage(prepared.timeoutResolution)
        : transcriptStop
          ? transcriptStop.message
          : resultErrorMessage(terminal);
      const terminalStopReason = terminal.status === "failed" ? terminal.error.message : terminal.stopReason;
      await emitAcpxLog(ctx, {
        type: terminal.status === "completed" ? "acpx.result" : "acpx.error",
        summary: terminal.status,
        stopReason: terminalStopReason,
        message: errorMessage,
      });
      // A turn that dies because the upstream stream was cut mid-response
      // ("Connection closed mid-response", a reset socket, an overloaded
      // upstream) is transient: the same prompt normally succeeds on a fresh
      // session. Reporting it as a deterministic `acpx_turn_failed` made the
      // heartbeat treat it as non-retryable, so a single dropped connection
      // killed the whole run with no recovery (TON-639).
      const terminalContextOverflowDetected =
        terminalContextOverflow ??
        (terminal.status === "failed"
          ? (classifyContextWindowOverflowFailure(terminalStopReason) ??
            classifyContextWindowOverflowFailure(errorMessage))
          : null);
      // A context-window refusal has TWO causes and they need different
      // recoveries: an oversized PROMPT is the replay problem TON-868 fixed,
      // while a transcript that grew during the attempt is TON-1001's. Tell
      // them apart by what actually filled the window, so the run history can
      // route them differently.
      const terminalContextOverflowFailure = terminalContextOverflowDetected
        ? classifyContextOverflowCause({
            promptChars: promptMetrics.promptChars ?? 0,
            transcriptChars,
            usage: usageSample,
            usageRatio: contextUsageStopRatio,
          })
        : null;
      const terminalTransientUpstream =
        terminalContextOverflowFailure
          ? null
          : terminal.status === "failed"
            ? (classifyTransientUpstreamFailure(terminalStopReason) ??
              classifyTransientUpstreamFailure(errorMessage))
            : null;
      // The preemptive transcript stop is its own outcome: the attempt was
      // stopped on purpose, so the run must report the distinct code rather
      // than a generic turn failure.
      const transcriptStopFailure = transcriptStop
        ? {
            errorCode: TRANSCRIPT_OVERFLOW_ERROR_CODE,
            errorFamily: TRANSCRIPT_OVERFLOW_ERROR_FAMILY,
            errorMeta: {
              category: "context_overflow",
              cause: "transcript",
              ...transcriptStop.detail,
            },
          }
        : null;
      const partialProgress = textParts.join("").trim();
      return {
        exitCode: terminal.status === "completed" ? 0 : 1,
        signal: timedOut ? "SIGTERM" : null,
        timedOut,
        errorMessage,
        errorCode:
          transcriptStopFailure?.errorCode ??
          terminalContextOverflowFailure?.errorCode ??
          terminalTransientUpstream?.errorCode ??
          (terminal.status === "failed" ? "acpx_turn_failed" : timedOut ? "acpx_timeout" : null),
        errorFamily:
          transcriptStopFailure?.errorFamily ??
          terminalContextOverflowFailure?.errorFamily ??
          terminalTransientUpstream?.errorFamily ??
          null,
        errorMeta: transcriptStopFailure?.errorMeta,
        sessionId: sessionHandle.backendSessionId ?? sessionHandle.runtimeSessionName,
        sessionParams: buildSessionParams({ prepared, handle: sessionHandle }),
        sessionDisplayId: sessionHandle.agentSessionId ?? sessionHandle.backendSessionId ?? sessionHandle.runtimeSessionName,
        provider: "acpx",
        model: prepared.requestedModel || null,
        billingType: "unknown",
        costUsd: null,
        resultJson: {
          status: terminal.status,
          stopReason: terminalStopReason,
          permissionMode: prepared.permissionMode,
          mode: prepared.mode,
          requestedModel: prepared.requestedModel || null,
          requestedThinkingEffort: prepared.requestedThinkingEffort || null,
          fastMode: prepared.fastMode,
          ...(transcriptStop ? { transcriptStop: transcriptStop.detail } : {}),
          // The partial progress the stopped attempt produced. It is durable
          // (it rides on the run row) so the NEXT attempt can resume from it
          // instead of from the transcript that crossed the window.
          ...(transcriptStop && partialProgress
            ? { partialProgress: partialProgress.slice(-TRANSCRIPT_PARTIAL_PROGRESS_MAX_CHARS) }
            : {}),
        },
        // A stopped attempt's text is the WHOLE transcript's assistant output,
        // so it is bounded like the partial progress. An unbounded summary
        // would inflate the run row and be replayed into the next attempt's
        // prompt - the very inflation this bound exists to prevent.
        summary: transcriptStop
          ? partialProgress.slice(-TRANSCRIPT_PARTIAL_PROGRESS_MAX_CHARS) ||
            terminalStopReason ||
            terminal.status
          : partialProgress || terminalStopReason || terminal.status,
        // The upstream stream was cut mid-response, so the session's last
        // assistant message is truncated. Resuming it would replay the same
        // broken turn, so drop the session and let the retry start clean.
        // A preemptive transcript stop drops it too: the persisted session
        // carries the very transcript that crossed the budget.
        clearSession:
          clearSession ||
          Boolean(terminalTransientUpstream) ||
          Boolean(terminalContextOverflowFailure) ||
          Boolean(transcriptStop),
      };
    } catch (err) {
      if (timeout) clearTimeout(timeout);
      const messageOverride = timedOut
        ? formatAdapterExecutionTimeoutErrorMessage(prepared.timeoutResolution)
        : undefined;
      const cancel = cancelActiveTurn as ((reason: string) => Promise<void>) | null;
      const preEmitMessage =
        messageOverride ?? (err instanceof Error ? err.message : String(err));
      if (cancel) await cancel(preEmitMessage).catch(() => {});
      await runtime.close({
        handle: sessionHandle,
        reason: timedOut ? "paperclip timeout cleanup" : "paperclip error cleanup",
        discardPersistentState: timedOut,
      }).catch(() => {});
      const existing = warmHandles.get(prepared.sessionKey);
      if (warmHandleMatches(existing, runtime, sessionHandle) && existing) {
        clearWarmHandleTimer(existing);
        warmHandles.delete(prepared.sessionKey);
      }
      const { classified, message } = await emitAcpxFailure({
        ctx,
        prepared,
        err,
        phase: "turn",
        messageOverride,
      });
      return {
        exitCode: 1,
        signal: timedOut ? "SIGTERM" : null,
        timedOut,
        errorMessage: message,
        errorCode: timedOut ? "acpx_timeout" : classified.errorCode,
        errorFamily: classified.errorFamily ?? null,
        errorMeta: classified.errorMeta,
        provider: "acpx",
        model: prepared.requestedModel || null,
        clearSession: clearSession || timedOut,
        resultJson: { phase: "turn" },
        summary: message,
      };
    }
  };
}


export const execute = createAcpxEngineExecutor();
