import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, posix, resolve, win32 } from "node:path";
import { adoptClaudeMcp, adoptCodexToml, adoptHooks, createAdoptContext, type AdoptContext } from "./adopt.js";
import { mcpRegistrationKind, isLauncherMcpRegistration } from "./commands.js";
import {
  LAUNCHER_SHIM_BASENAMES,
  MCP_LAUNCHER_RELATIVE_PATH,
  MCP_SERVER_RELATIVE_PATH,
  SKILL_SOURCE_RELATIVE_PATH,
  TOML_BLOCK_END,
  TOML_BLOCK_START,
} from "./constants.js";
import {
  displayPath,
  backupPathFor,
  fingerprintOf,
  lineEndingNeutralSha256,
  readRegularFile,
  sha256,
} from "./files.js";
import { getClaudeHookSpecs, getClaudeMcpSpec, getCodexHookSpecs } from "./hook-specs.js";
import { inspectAgentRegistrations } from "./inspect.js";
import { parseJsonFile, removeJsonSpec, addJsonSpec, serializeJson } from "./json-config.js";
import { entryIndex, manifestPath, parseManifest, removeEntry, setEntry } from "./manifest.js";
import { normalizePlanOptions, targetPath } from "./paths.js";
import { readClaudePluginEnabled, readCodexPluginEnabled } from "./plugins.js";
import {
  codexHooksFeatureFromToml,
  codexTomlBlock,
  codexWorkIntelligenceServer,
  insertCodexBlockBeforeToolApprovals,
  moveCodexToolTablesOutOfBlock,
  removeCodexBlockWithToolApprovals,
  tomlHasUnsupportedMcpEntry,
  upgradeDirectCodexRegistration,
} from "./toml.js";
import type {
  AgentSetupComponentId,
  AgentSetupFileMutation,
  AgentSetupFinding,
  AgentSetupPlan,
  AgentSetupPlanOptions,
  CodexHooksFeature,
  JsonMutationSpec,
  ReadFileResult,
  SetupManifest,
} from "./types.js";

/**
 * Hashes of every committed version of the canonical skill. A user-scope copy byte-identical to one of them was
 * copied from this repository and never customised, so setup may upgrade it even without an ownership record.
 * Returns an empty set when Git or the history is unavailable, which keeps the conservative refuse-to-overwrite path.
 */
export function publishedSkillHashes(repositoryRoot: string): Set<string> {
  const hashes = new Set<string>();
  const git = (args: string[], input?: string): Buffer =>
    execFileSync("git", ["-C", repositoryRoot, ...args], {
      input,
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    });
  try {
    const commits = git(["rev-list", "HEAD", "--", SKILL_SOURCE_RELATIVE_PATH])
      .toString("utf8")
      .split(/\s+/)
      .filter(Boolean);
    if (!commits.length) return hashes;
    const output = git(
      ["cat-file", "--batch"],
      commits.map((commit) => `${commit}:${SKILL_SOURCE_RELATIVE_PATH}\n`).join(""),
    );
    let offset = 0;
    while (offset < output.length) {
      const headerEnd = output.indexOf(0x0a, offset);
      if (headerEnd < 0) break;
      const header = output.subarray(offset, headerEnd).toString("utf8").split(" ");
      offset = headerEnd + 1;
      if (header[1] !== "blob") continue;
      const size = Number(header[2]);
      hashes.add(lineEndingNeutralSha256(output.subarray(offset, offset + size)));
      offset += size + 1;
    }
  } catch {
    hashes.clear();
  }
  return hashes;
}

export function skillLabel(id: "codexSkill" | "codexLegacySkill" | "claudeSkill"): string {
  if (id === "codexSkill") return "Codex canonical user-scope skill";
  if (id === "codexLegacySkill") return "Codex legacy compatibility skill copy";
  return "Claude Code user-scope skill";
}

export function stageMutation(
  plan: AgentSetupPlan,
  options: AgentSetupPlanOptions,
  path: string,
  label: string,
  before: Buffer | null,
  after: Buffer | null,
  mode: number,
): void {
  if (before?.equals(after ?? Buffer.alloc(0)) && after !== null) return;
  if (before === null && after === null) return;
  if (before && after && before.equals(after)) return;
  const mutation: AgentSetupFileMutation = {
    path,
    label,
    before,
    after,
    mode,
    beforeFingerprint: fingerprintOf(before),
    afterFingerprint: fingerprintOf(after),
  };
  if (before) mutation.backupPath = backupPathFor(path, before, options.now ?? new Date());
  plan.mutations.push(mutation);
  const verb = after === null ? "移除" : before ? "更新" : "建立";
  plan.actions.push(
    `${verb} ${label}：${displayPath(path, options.homeDirectory)}${mutation.backupPath ? `（備份：${displayPath(mutation.backupPath, options.homeDirectory)}）` : ""}`,
  );
}

/**
 * Why a launcher shim path cannot be written into hook command lines, or `undefined` when it can. The path is quoted
 * for the platform's shell, but these characters still break or inject under cmd.exe (`%`, `^`, `&`, `!`, `"`) and
 * under Git Bash or sh (`$`, a backtick), and a newline or control character ends the command line. The file name must
 * be the fixed shim name for the platform, and on Windows only `X:\` drive paths are accepted (no UNC or device paths).
 */
function launcherShimConflict(shimPath: string, platform: NodeJS.Platform): string | undefined {
  const windows = platform === "win32";
  if (!(windows ? win32 : posix).isAbsolute(shimPath)) {
    return "launcher-shim-not-absolute：launcher shim 路徑必須是絕對路徑；保留且拒絕修改。";
  }
  if (windows && !/^[A-Za-z]:[\\/]/.test(shimPath)) {
    return "launcher-shim-not-drive-path：launcher shim 路徑必須是 X:\\ 磁碟路徑，不接受 UNC 或裝置路徑；保留且拒絕修改。";
  }
  if (/[$`%"!^&]/.test(shimPath) || [...shimPath].some((char) => char <= "\u001f" || char === "\u007f")) {
    return "launcher-shim-unsafe-characters：launcher shim 路徑含有會破壞或注入 hook 指令的字元；保留且拒絕修改。";
  }
  const name = (windows ? win32 : posix).basename(shimPath);
  const allowed = [...LAUNCHER_SHIM_BASENAMES].filter((basename) => basename.endsWith(".cmd") === windows);
  if (!allowed.includes(windows ? name.toLowerCase() : name)) {
    return "launcher-shim-name-invalid：launcher shim 檔名不是固定的 work-intelligence-launcher shim；保留且拒絕修改。";
  }
  return undefined;
}

export function addConflict(plan: AgentSetupPlan, message: string): void {
  if (!plan.conflicts.includes(message)) plan.conflicts.push(message);
}

const ADOPT_REQUIRES_LAUNCHER = "adopt-requires-launcher：改由桌面 App 管理只能搭配 launcher 目標；保留且拒絕修改。";

/** How an MCP server entry relates to the planned target; "launcher" means it already points at the target. */
function registrationKind(value: unknown, options: AgentSetupPlanOptions): "launcher" | "direct" | "other" {
  if (options.target?.kind === "launcher") {
    return isLauncherMcpRegistration(value, options.target.shimPath) ? "launcher" : "other";
  }
  return mcpRegistrationKind(value, options.repositoryRoot);
}

/** @internal test-only */
export function installPlan(options: AgentSetupPlanOptions): AgentSetupPlan {
  const plan: AgentSetupPlan = { mode: "install", actions: [], conflicts: [], mutations: [], findings: [] };
  options = normalizePlanOptions(options);
  const homeDirectory = options.homeDirectory;
  const repositoryRoot = options.repositoryRoot;
  const launcherTarget = options.target?.kind === "launcher" ? options.target : undefined;
  if (launcherTarget) {
    const platform = options.platform ?? process.platform;
    const shimConflict = launcherShimConflict(launcherTarget.shimPath, platform);
    if (shimConflict) addConflict(plan, shimConflict);
  } else {
    if (options.adopt) addConflict(plan, ADOPT_REQUIRES_LAUNCHER);
    for (const relativePath of [
      MCP_SERVER_RELATIVE_PATH,
      MCP_LAUNCHER_RELATIVE_PATH,
      "apps/mcp/dist/finalize-reminder.js",
      "apps/mcp/dist/codex-finalize-reminder.js",
    ]) {
      if (!existsSync(join(repositoryRoot, relativePath))) {
        addConflict(plan, `缺少 ${relativePath}；請先執行 pnpm build，再重新預覽。`);
      }
    }
  }
  const manifestTarget = manifestPath(homeDirectory);
  const manifestFile = readRegularFile(manifestTarget);
  if (manifestFile.conflict) addConflict(plan, manifestFile.conflict);
  const parsedManifest = parseManifest(manifestFile.bytes);
  if (parsedManifest.conflict) addConflict(plan, parsedManifest.conflict);
  if (
    parsedManifest.manifest.components.length > 0 &&
    ((parsedManifest.manifest.codexHomeDirectory &&
      parsedManifest.manifest.codexHomeDirectory !== options.codexHomeDirectory) ||
      (parsedManifest.manifest.claudeConfigDirectory &&
        parsedManifest.manifest.claudeConfigDirectory !== options.claudeConfigDirectory))
  ) {
    addConflict(
      plan,
      "安裝時使用的 CODEX_HOME 或 CLAUDE_CONFIG_DIR 已變更；請先用原設定解除安裝，避免操作到其他設定目錄。",
    );
  }
  const components = parsedManifest.manifest.components;
  const platform = options.platform ?? process.platform;
  let adoptContext: AdoptContext | undefined;
  if (launcherTarget && options.adopt) {
    const labels = new Map<AgentSetupComponentId, string>(
      [...getClaudeHookSpecs(options, platform), ...getCodexHookSpecs(options, platform)].map((spec) => [
        spec.id,
        spec.label,
      ]),
    );
    labels.set("claudeMcp", "Claude MCP 註冊");
    labels.set("codexMcp", "Codex MCP 註冊");
    plan.adopted = [];
    adoptContext = createAdoptContext({
      plan,
      options,
      components,
      shimPath: launcherTarget.shimPath,
      platform,
      labels,
    });
  }
  // An enabled plugin already provides MCP, skill and hooks for that Agent; registering them again would duplicate them.
  const claudePlugin = readClaudePluginEnabled(options.claudeConfigDirectory!);
  const codexPlugin = readCodexPluginEnabled(options.codexHomeDirectory!);
  // An Agent the caller did not select is left alone like one a plugin serves: its files are not even read, so a conflict
  // there never blocks the other Agent (M-17).
  const selected = new Set(options.agents ?? ["codex", "claude-code"]);
  const skipClaude = claudePlugin || !selected.has("claude-code");
  const skipCodex = codexPlugin || !selected.has("codex");
  if (claudePlugin) {
    plan.actions.push(
      "Claude Code 已啟用 work-intelligence plugin，略過手動註冊（plugin 已提供 MCP、skill 與 hook）。",
    );
  }
  if (codexPlugin) {
    plan.actions.push("Codex 已啟用 work-intelligence plugin，略過手動註冊（plugin 已提供 MCP、skill 與 hook）。");
  }
  const sourcePath = launcherTarget?.skillSourcePath ?? join(repositoryRoot, SKILL_SOURCE_RELATIVE_PATH);
  const sourceFile = readRegularFile(sourcePath);
  if (sourceFile.conflict || !sourceFile.bytes) {
    addConflict(plan, `找不到可安裝的 work-intelligence skill：${displayPath(sourcePath, homeDirectory)}。`);
  }
  const skillBytes = sourceFile.bytes ?? Buffer.alloc(0);
  const skillHash = sha256(skillBytes);
  let publishedHashes: Set<string> | undefined;
  // Git history only knows the checkout's skill; an App-shipped copy has no published predecessors to recognise.
  const isPublishedSkillCopy = (bytes: Buffer): boolean =>
    !launcherTarget && (publishedHashes ??= publishedSkillHashes(repositoryRoot)).has(lineEndingNeutralSha256(bytes));

  for (const id of ["codexSkill", "codexLegacySkill", "claudeSkill"] as const) {
    if (id === "claudeSkill" ? skipClaude : skipCodex) continue;
    const path = targetPath(id, options);
    const current = readRegularFile(path);
    if (current.conflict) addConflict(plan, current.conflict);
    const ownedIndex = entryIndex(components, id);
    const owned = ownedIndex >= 0 ? components[ownedIndex] : undefined;
    const currentHash = current.bytes ? sha256(current.bytes) : undefined;
    if (currentHash === skillHash) {
      if (owned?.kind === "file") setEntry(components, { id, kind: "file", expected: skillHash });
      continue;
    }
    const ownedAndUnchanged = owned?.kind === "file" && currentHash === owned.expected;
    if (current.bytes && !ownedAndUnchanged && !isPublishedSkillCopy(current.bytes)) {
      addConflict(plan, `${displayPath(path, homeDirectory)} 已有不同內容；保留且拒絕覆寫。`);
      continue;
    }
    stageMutation(plan, options, path, skillLabel(id), current.bytes, skillBytes, current.mode);
    setEntry(components, { id, kind: "file", expected: skillHash });
  }

  const tomlPath = targetPath("codexMcp", options);
  const tomlFile: ReadFileResult = skipCodex ? { bytes: null, mode: 0o600 } : readRegularFile(tomlPath);
  if (tomlFile.conflict) addConflict(plan, tomlFile.conflict);
  const tomlText = tomlFile.bytes?.toString("utf8") ?? "";
  const tomlNewline = tomlText.includes("\r\n") ? "\r\n" : "\n";
  const desiredBlock = codexTomlBlock(options, tomlNewline);
  const tomlEntryIndex = entryIndex(components, "codexMcp");
  const tomlOwned = tomlEntryIndex >= 0 ? components[tomlEntryIndex] : undefined;
  const tomlOwnedExpected = tomlOwned?.kind === "toml-block" ? tomlOwned.expected : undefined;
  const codexRegistration = registrationKind(codexWorkIntelligenceServer(tomlText), options);
  /** A removal used to leave Codex's tool approvals alone in the file: the block goes in front of them and they stay. */
  const stageToolApprovalBlock = (): void => {
    const next = insertCodexBlockBeforeToolApprovals(tomlText, desiredBlock) ?? tomlText;
    stageMutation(plan, options, tomlPath, "Codex MCP 註冊", tomlFile.bytes, Buffer.from(next, "utf8"), tomlFile.mode);
    setEntry(components, { id: "codexMcp", kind: "toml-block", expected: desiredBlock });
  };
  const adoptedToml = !skipCodex && adoptContext ? adoptCodexToml(tomlText, adoptContext, tomlPath) : undefined;
  if (skipCodex) {
    // A plugin registers the MCP server, or Codex was not selected; leave config.toml alone.
  } else if (adoptedToml !== undefined) {
    stageMutation(
      plan,
      options,
      tomlPath,
      "Codex MCP 註冊",
      tomlFile.bytes,
      Buffer.from(adoptedToml, "utf8"),
      tomlFile.mode,
    );
  } else if (tomlText.includes(desiredBlock)) {
    if (tomlOwned?.kind === "toml-block" && tomlOwned.expected !== desiredBlock)
      setEntry(components, { id: "codexMcp", kind: "toml-block", expected: desiredBlock });
  } else if (
    tomlOwned?.adopted &&
    tomlOwnedExpected &&
    tomlText.includes(tomlOwnedExpected) &&
    codexRegistration === "launcher"
  ) {
    // An adopted block already points at the launcher and keeps the hand-written keys inside it.
  } else if (tomlOwnedExpected && tomlText.includes(tomlOwnedExpected)) {
    const next = tomlText.replace(tomlOwnedExpected, desiredBlock);
    stageMutation(plan, options, tomlPath, "Codex MCP 註冊", tomlFile.bytes, Buffer.from(next, "utf8"), tomlFile.mode);
    setEntry(components, { id: "codexMcp", kind: "toml-block", expected: desiredBlock });
  } else if (!tomlOwned && codexRegistration === "launcher") {
    plan.actions.push("保留既有 Codex MCP 註冊：已指向這個 Work Intelligence，不修改。");
  } else if (!tomlOwned && codexRegistration === "direct") {
    const upgraded = upgradeDirectCodexRegistration(tomlText, repositoryRoot);
    if (upgraded) {
      stageMutation(
        plan,
        options,
        tomlPath,
        "Codex MCP 註冊",
        tomlFile.bytes,
        Buffer.from(upgraded, "utf8"),
        tomlFile.mode,
      );
      plan.actions.push("更新既有 Codex MCP 註冊：改用 MCP launcher，建置更新後不必重新連線；其餘自訂設定保留。");
    } else {
      plan.actions.push(
        "保留既有 Codex MCP 註冊：直接執行 server，無法安全改寫；建置更新後需重新連線，可手動把 args 改成 apps/mcp/dist/launcher.js。",
      );
    }
  } else if (tomlOwned && !tomlText.includes(tomlOwnedExpected ?? "")) {
    const moved = moveCodexToolTablesOutOfBlock(tomlText, tomlOwnedExpected ?? "", desiredBlock, tomlNewline);
    if (moved) {
      stageMutation(
        plan,
        options,
        tomlPath,
        "Codex MCP 註冊",
        tomlFile.bytes,
        Buffer.from(moved, "utf8"),
        tomlFile.mode,
      );
      setEntry(components, { id: "codexMcp", kind: "toml-block", expected: desiredBlock });
    } else if (tomlText.includes(TOML_BLOCK_START) || tomlText.includes(TOML_BLOCK_END)) {
      addConflict(plan, "Codex MCP 的安裝區塊已被修改；保留且拒絕覆寫。");
    } else if (insertCodexBlockBeforeToolApprovals(tomlText, desiredBlock) !== undefined) {
      stageToolApprovalBlock();
    } else if (!tomlHasUnsupportedMcpEntry(tomlText)) {
      const prefix = tomlText && !tomlText.endsWith("\n") ? tomlText + tomlNewline : tomlText;
      stageMutation(
        plan,
        options,
        tomlPath,
        "Codex MCP 註冊",
        tomlFile.bytes,
        Buffer.from(prefix + desiredBlock, "utf8"),
        tomlFile.mode,
      );
      setEntry(components, { id: "codexMcp", kind: "toml-block", expected: desiredBlock });
    } else {
      addConflict(plan, "Codex config.toml 已有未支援的 mcp_servers 結構；保留且拒絕修改。");
    }
  } else if (insertCodexBlockBeforeToolApprovals(tomlText, desiredBlock) !== undefined) {
    stageToolApprovalBlock();
  } else if (tomlHasUnsupportedMcpEntry(tomlText)) {
    addConflict(plan, "Codex config.toml 已有未支援的 mcp_servers 結構；保留且拒絕修改。");
  } else {
    const prefix = tomlText && !tomlText.endsWith("\n") ? tomlText + tomlNewline : tomlText;
    stageMutation(
      plan,
      options,
      tomlPath,
      "Codex MCP 註冊",
      tomlFile.bytes,
      Buffer.from(prefix + desiredBlock, "utf8"),
      tomlFile.mode,
    );
    setEntry(components, { id: "codexMcp", kind: "toml-block", expected: desiredBlock });
  }

  const codexFeature = skipCodex ? "enabled" : codexHooksFeatureFromToml(tomlText);
  if (codexFeature === "disabled") {
    plan.actions.push("保留 ~/.codex/config.toml 的 [features].hooks=false；略過 Codex hooks 設定。");
  } else if (codexFeature === "unknown") {
    plan.actions.push("無法安全判斷 Codex hooks 是否停用；保留設定並略過 Codex hooks。");
  }

  const jsonFileChanges = new Map<
    string,
    { before: Buffer | null; mode: number; root: Record<string, unknown>; changed: boolean }
  >();
  const mutateJson = (path: string, specs: JsonMutationSpec[], adopt?: (root: Record<string, unknown>) => boolean) => {
    const loaded = parseJsonFile(path, homeDirectory, plan.conflicts);
    const changes = { before: loaded.before, mode: loaded.mode, root: loaded.root, changed: false };
    changes.changed = adopt?.(loaded.root) ?? false;
    for (const spec of specs)
      changes.changed = addJsonSpec(changes.root, components, spec, plan.conflicts, plan.actions) || changes.changed;
    jsonFileChanges.set(path, changes);
  };

  if (!skipClaude) {
    const claudeJsonPath = targetPath("claudeMcp", options);
    const claudeSettingsPath = targetPath("claudeStopHook", options);
    mutateJson(
      claudeJsonPath,
      [getClaudeMcpSpec(options)],
      adoptContext && ((root) => adoptClaudeMcp(root, adoptContext, claudeJsonPath)),
    );
    mutateJson(
      claudeSettingsPath,
      getClaudeHookSpecs(options, platform),
      adoptContext && ((root) => adoptHooks(root, "claude-code", adoptContext, claudeSettingsPath)),
    );
  }
  if (!skipCodex && codexFeature !== "disabled" && codexFeature !== "unknown") {
    const codexHooksPath = targetPath("codexStopHook", options);
    mutateJson(
      codexHooksPath,
      getCodexHookSpecs(options, platform),
      adoptContext && ((root) => adoptHooks(root, "codex", adoptContext, codexHooksPath)),
    );
  }

  for (const [path, file] of jsonFileChanges) {
    if (file.changed)
      stageMutation(
        plan,
        options,
        path,
        "Agent JSON 設定",
        file.before,
        serializeJson(file.root, file.before),
        file.mode,
      );
  }

  const nextManifest: SetupManifest = {
    version: 2,
    codexHomeDirectory: options.codexHomeDirectory,
    claudeConfigDirectory: options.claudeConfigDirectory,
    components,
  };
  const manifestAfter = components.length ? Buffer.from(JSON.stringify(nextManifest, null, 2) + "\n", "utf8") : null;
  stageMutation(
    plan,
    options,
    manifestTarget,
    "Work Intelligence 安裝紀錄",
    manifestFile.bytes,
    manifestAfter,
    manifestFile.mode,
  );
  if (!plan.actions.length) plan.actions.push("Codex 與 Claude Code 的 MCP、skill 及可用 hooks 已符合設定；不需變更。");
  plan.findings = inspectAgentRegistrations(options).duplicates;
  return plan;
}

/** @internal test-only */
export function uninstallPlan(options: AgentSetupPlanOptions): AgentSetupPlan {
  const plan: AgentSetupPlan = { mode: "uninstall", actions: [], conflicts: [], mutations: [], findings: [] };
  options = normalizePlanOptions(options);
  if (options.adopt) addConflict(plan, ADOPT_REQUIRES_LAUNCHER);
  const homeDirectory = options.homeDirectory;
  const path = manifestPath(homeDirectory);
  const file = readRegularFile(path);
  if (file.conflict) addConflict(plan, file.conflict);
  const parsed = parseManifest(file.bytes);
  if (parsed.conflict) addConflict(plan, parsed.conflict);
  options = normalizePlanOptions({
    ...options,
    codexHomeDirectory: parsed.manifest.codexHomeDirectory ?? options.codexHomeDirectory,
    claudeConfigDirectory: parsed.manifest.claudeConfigDirectory ?? options.claudeConfigDirectory,
  });
  if (!file.bytes) {
    plan.actions.push("沒有 Work Intelligence 安裝紀錄；未移除任何設定。");
    return plan;
  }
  const remaining = [...parsed.manifest.components];
  const changedJson = new Map<
    string,
    { before: Buffer | null; mode: number; root: Record<string, unknown>; changed: boolean }
  >();
  const loadJson = (target: string) => {
    const existing = changedJson.get(target);
    if (existing) return existing;
    const loaded = parseJsonFile(target, homeDirectory, plan.conflicts);
    const result = { before: loaded.before, mode: loaded.mode, root: loaded.root, changed: false };
    changedJson.set(target, result);
    return result;
  };

  for (const entry of parsed.manifest.components) {
    const target = targetPath(entry.id, options);
    if (entry.kind === "file") {
      const current = readRegularFile(target);
      if (current.conflict) {
        addConflict(plan, current.conflict);
      } else if (!current.bytes) {
        removeEntry(remaining, entry.id);
      } else if (sha256(current.bytes) === entry.expected) {
        stageMutation(plan, options, target, skillLabel(entry.id), current.bytes, null, current.mode);
        removeEntry(remaining, entry.id);
      } else {
        addConflict(plan, `${displayPath(target, homeDirectory)} 已在安裝後修改；保留且不解除安裝。`);
      }
      continue;
    }
    if (entry.kind === "toml-block") {
      const current = readRegularFile(target);
      if (current.conflict) addConflict(plan, current.conflict);
      const text = current.bytes?.toString("utf8") ?? "";
      const openCount = text.split(TOML_BLOCK_START).length - 1;
      const closeCount = text.split(TOML_BLOCK_END).length - 1;
      const removed = removeCodexBlockWithToolApprovals(text, entry.expected, text.includes("\r\n") ? "\r\n" : "\n");
      if (!current.bytes || (openCount === 0 && closeCount === 0)) {
        removeEntry(remaining, entry.id);
      } else if (openCount === 1 && closeCount === 1 && removed !== undefined) {
        stageMutation(
          plan,
          options,
          target,
          "Codex MCP 註冊",
          current.bytes,
          Buffer.from(removed, "utf8"),
          current.mode,
        );
        removeEntry(remaining, entry.id);
      } else {
        addConflict(plan, "Codex MCP 的安裝區塊已在安裝後修改；保留且不解除安裝。");
      }
      continue;
    }
    if (entry.kind === "json-property") {
      const spec = getClaudeMcpSpec(options);
      const targetFile = loadJson(target);
      targetFile.changed =
        removeJsonSpec(targetFile.root, remaining, entry, spec.path, undefined, plan.conflicts, "Claude MCP 註冊") ||
        targetFile.changed;
      continue;
    }
    const platform = options.platform ?? process.platform;
    const spec = [...getClaudeHookSpecs(options, platform), ...getCodexHookSpecs(options, platform)].find(
      (item) => item.id === entry.id,
    );
    if (!spec) {
      addConflict(plan, `無法識別 ${entry.id} 的安裝項目；保留安裝紀錄。`);
      continue;
    }
    const targetFile = loadJson(target);
    targetFile.changed =
      removeJsonSpec(targetFile.root, remaining, entry, spec.path, spec.similar, plan.conflicts, spec.label) ||
      targetFile.changed;
  }

  for (const [target, targetFile] of changedJson) {
    if (targetFile.changed)
      stageMutation(
        plan,
        options,
        target,
        "Agent JSON 設定",
        targetFile.before,
        serializeJson(targetFile.root, targetFile.before),
        targetFile.mode,
      );
  }
  const remainingManifest = remaining.length
    ? Buffer.from(
        JSON.stringify(
          {
            version: 2,
            codexHomeDirectory: options.codexHomeDirectory,
            claudeConfigDirectory: options.claudeConfigDirectory,
            components: remaining,
          },
          null,
          2,
        ) + "\n",
        "utf8",
      )
    : null;
  stageMutation(plan, options, path, "Work Intelligence 安裝紀錄", file.bytes, remainingManifest, file.mode);
  if (!plan.actions.length) plan.actions.push("沒有可安全移除的 Work Intelligence 設定。");
  return plan;
}

export function inspectAgentSkillCopies(
  homeDirectory: string,
  repositoryRoot: string,
  codexHomeDirectory?: string,
  claudeConfigDirectory?: string,
): AgentSetupFinding[] {
  const options = normalizePlanOptions({ homeDirectory, repositoryRoot, codexHomeDirectory, claudeConfigDirectory });
  const sourcePath = join(options.repositoryRoot, SKILL_SOURCE_RELATIVE_PATH);
  const source = readRegularFile(sourcePath);
  const ids = ["codexSkill", "codexLegacySkill", "claudeSkill"] as const;
  return ids.map((id) => {
    const path = targetPath(id, options);
    const current = readRegularFile(path);
    if (source.conflict || !source.bytes) {
      return { componentId: id, state: "unreadable", detail: "找不到 repo 內的 canonical work-intelligence skill。" };
    }
    if (current.conflict) return { componentId: id, state: "unreadable", detail: "無法安全讀取 user-scope skill。" };
    if (!current.bytes) {
      const detail =
        id === "codexLegacySkill"
          ? "尚未安裝 CODEX_HOME 下的 Codex legacy compatibility skill 複本。"
          : id === "codexSkill"
            ? "尚未安裝 home/.agents/skills 下的 Codex canonical skill。"
            : "尚未安裝 Claude Code user-scope skill。";
      return { componentId: id, state: "missing", detail };
    }
    return sha256(current.bytes) === sha256(source.bytes)
      ? {
          componentId: id,
          state: "current",
          detail:
            id === "codexLegacySkill"
              ? "CODEX_HOME 下的 compatibility 複本與 canonical skill 內容完全相同。"
              : "內容與 repo 內的 canonical skill 完全相同。",
        }
      : {
          componentId: id,
          state: "stale",
          detail:
            id === "codexLegacySkill"
              ? "CODEX_HOME 下的 compatibility 複本與 repo 內版本不同。"
              : "user-scope skill 與 repo 內版本不同。",
        };
  });
}

export function inspectCodexHooksFeature(homeDirectory: string, codexHomeDirectory?: string): CodexHooksFeature {
  const path = join(resolve(codexHomeDirectory ?? join(homeDirectory, ".codex")), "config.toml");
  const file = readRegularFile(path);
  if (file.conflict) return "unknown";
  return codexHooksFeatureFromToml(file.bytes?.toString("utf8"));
}

export function createAgentSetupPlan(
  options: AgentSetupPlanOptions,
  mode: "install" | "uninstall" = "install",
): AgentSetupPlan {
  return mode === "install" ? installPlan(options) : uninstallPlan(options);
}
