import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDatabaseCli, type DatabaseCliDependencies } from "../../apps/server/src/cli.js";
import { canonicalizeProjectRoot, WorkIntelligenceStore } from "../../packages/storage/src/index.js";

const stores: WorkIntelligenceStore[] = [];
const tempDirs: string[] = [];
const originalInitCwd = process.env.INIT_CWD;

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
  if (originalInitCwd === undefined) delete process.env.INIT_CWD;
  else process.env.INIT_CWD = originalInitCwd;
});

function createTemp(): string {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-track-"));
  tempDirs.push(root);
  return root;
}

function createFolder(parent: string, name: string): string {
  const folder = join(parent, name);
  mkdirSync(folder, { recursive: true });
  return folder;
}

function setup(options: { interactive?: boolean; answer?: boolean; invocationDirectory?: string | null } = {}) {
  const store = new WorkIntelligenceStore(":memory:");
  stores.push(store);
  const messages = { log: [] as string[], error: [] as string[] };
  let prompts = 0;
  const dependencies: DatabaseCliDependencies = {
    withStore: <T>(task: (activeStore: WorkIntelligenceStore) => T) => task(store),
    log: (message) => messages.log.push(message),
    error: (message) => messages.error.push(message),
    ...(options.invocationDirectory === null ? {} : { invocationDirectory: options.invocationDirectory ?? tmpdir() }),
    track: {
      isInteractive: () => options.interactive ?? false,
      confirm: async () => {
        prompts += 1;
        return options.answer ?? false;
      },
      port: 3210,
    },
  };
  return { store, messages, dependencies, prompts: () => prompts };
}

describe("pnpm track", () => {
  it("previews then tracks a new project after the user confirms", async () => {
    const folder = createFolder(createTemp(), "demo-app");
    const { store, messages, dependencies, prompts } = setup({ interactive: true, answer: true });

    expect(await runDatabaseCli(["track", folder], dependencies)).toBe(0);

    expect(prompts()).toBe(1);
    const projects = store.listProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({
      name: "demo-app",
      rootPath: canonicalizeProjectRoot(folder),
      status: "tracked",
    });
    const output = messages.log.join("\n");
    expect(output).toContain("預覽");
    expect(output).toContain("記錄中");
    expect(output).toContain("http://127.0.0.1:3210");
    expect(output).toContain("重新連線 MCP");
  });

  it("does not write when the user declines", async () => {
    const folder = createFolder(createTemp(), "demo-app");
    const { store, messages, dependencies } = setup({ interactive: true, answer: false });

    expect(await runDatabaseCli(["track", folder], dependencies)).toBe(0);

    expect(store.listProjects()).toHaveLength(0);
    expect(messages.log.join("\n")).toContain("已取消");
  });

  it("only previews in a non-interactive terminal without --yes", async () => {
    const folder = createFolder(createTemp(), "demo-app");
    const { store, messages, dependencies, prompts } = setup({ interactive: false });

    expect(await runDatabaseCli(["track", folder], dependencies)).toBe(0);

    expect(prompts()).toBe(0);
    expect(store.listProjects()).toHaveLength(0);
    expect(messages.log.join("\n")).toContain("只顯示預覽");
  });

  it("applies without a prompt when --yes is given", async () => {
    const folder = createFolder(createTemp(), "demo-app");
    const { store, dependencies, prompts } = setup({ interactive: false });

    expect(await runDatabaseCli(["track", folder, "--yes"], dependencies)).toBe(0);

    expect(prompts()).toBe(0);
    expect(store.listProjects()[0]?.status).toBe("tracked");
  });

  it("leaves an already tracked project untouched", async () => {
    const folder = createFolder(createTemp(), "demo-app");
    const { store, messages, dependencies } = setup();
    const project = store.addProject("既有專案", folder);
    store.updateProject(project.id, { status: "tracked" });
    const before = store.getProjectById(project.id);

    expect(await runDatabaseCli(["track", folder, "--yes", "--name", "新名稱"], dependencies)).toBe(0);

    expect(store.getProjectById(project.id)).toEqual(before);
    expect(messages.log.join("\n")).toContain("已在記錄中");
  });

  it("switches a paused project to tracked and shows the current status", async () => {
    const folder = createFolder(createTemp(), "demo-app");
    const { store, messages, dependencies } = setup();
    const project = store.addProject("暫停中的專案", folder);
    store.updateProject(project.id, { status: "paused" });

    expect(await runDatabaseCli(["track", folder, "--yes"], dependencies)).toBe(0);

    expect(store.listProjects()).toHaveLength(1);
    expect(store.getProjectById(project.id)).toMatchObject({ name: "暫停中的專案", status: "tracked" });
    expect(messages.log.join("\n")).toContain("已暫停 → 記錄中");
  });

  it("exits 1 when the folder does not exist", async () => {
    const { store, messages, dependencies } = setup();

    expect(await runDatabaseCli(["track", join(createTemp(), "missing"), "--yes"], dependencies)).toBe(1);

    expect(store.listProjects()).toHaveLength(0);
    expect(messages.error.join("\n")).toContain("找不到資料夾");
  });

  it("resolves a relative folder against INIT_CWD, not the process directory", async () => {
    const parent = createTemp();
    const folder = createFolder(parent, "relative-app");
    process.env.INIT_CWD = parent;
    const { store, dependencies } = setup({ invocationDirectory: null });

    expect(await runDatabaseCli(["track", "relative-app", "--yes"], dependencies)).toBe(0);

    expect(store.listProjects()[0]?.rootPath).toBe(canonicalizeProjectRoot(folder));
  });

  it("uses --name for the project name", async () => {
    const folder = createFolder(createTemp(), "demo-app");
    const { store, dependencies } = setup();

    expect(await runDatabaseCli(["track", folder, "--name", "我的專案", "--yes"], dependencies)).toBe(0);
    expect(store.listProjects()[0]?.name).toBe("我的專案");
    expect(basename(folder)).toBe("demo-app");
  });

  it("warns about overlapping roots but still tracks, like adding a project in the Web UI", async () => {
    const parent = createTemp();
    const outer = createFolder(parent, "outer");
    const inner = createFolder(outer, "inner");
    const { store, messages, dependencies } = setup();
    store.addProject("外層專案", outer);

    expect(await runDatabaseCli(["track", inner, "--yes"], dependencies)).toBe(0);

    expect(store.listProjects()).toHaveLength(2);
    expect(store.listProjects().find((project) => project.name === "inner")?.status).toBe("tracked");
    expect(messages.log.join("\n")).toContain("與專案「外層專案」的根目錄重疊");
  });

  it.each([[[]], [["a", "b"]], [["folder", "--unknown"]], [["folder", "--name"]]])(
    "prints usage and exits 2 for bad arguments %j",
    async (extra) => {
      const { store, messages, dependencies } = setup();

      expect(await runDatabaseCli(["track", ...extra], dependencies)).toBe(2);

      expect(store.listProjects()).toHaveLength(0);
      expect(messages.error.join("\n")).toContain("用法：");
    },
  );
});
