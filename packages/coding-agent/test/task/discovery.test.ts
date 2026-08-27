import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { disableProvider, enableProvider } from "@oh-my-pi/pi-coding-agent/capability";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { clearClaudePluginRootsCache } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import {
	clearOmpExtensionCliRoots,
	injectOmpExtensionCliRoots,
} from "@oh-my-pi/pi-coding-agent/discovery/omp-extension-roots";
import { discoverAgents } from "@oh-my-pi/pi-coding-agent/task/discovery";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const OMP_AGENT_MD = [
	"---",
	"name: omp-test-agent",
	"description: OMP-native test agent.",
	"---",
	"You are an OMP task agent.",
].join("\n");

const OMP_PLUGIN_AGENT_MD = [
	"---",
	"name: loom-verify-spec",
	"description: Plugin-shipped verification agent.",
	"---",
	"You verify the loom spec.",
].join("\n");

const CLAUDE_AGENT_MD = [
	"---",
	"name: cc-test-agent",
	"description: Test Claude Code agent.",
	"tools: Read, Grep, Glob, Bash",
	"model: sonnet",
	"color: purple",
	"---",
	"You are a Claude Code custom subagent.",
].join("\n");

const PLUGIN_AGENT_MD = [
	"---",
	"name: simplifier",
	"description: A code simplifier agent from a Claude plugin",
	"---",
	"Simplify code.",
].join("\n");

async function writeOmpPluginAgent(home: string): Promise<void> {
	const userPluginsRoot = path.join(home, ".omp", "plugins");
	const pluginRoot = path.join(userPluginsRoot, "node_modules", "loom");
	await fs.mkdir(path.join(pluginRoot, "agents"), { recursive: true });
	await fs.writeFile(
		path.join(pluginRoot, "package.json"),
		JSON.stringify({ name: "loom", version: "1.0.0", omp: { version: "1.0.0" } }),
	);
	await fs.writeFile(
		path.join(userPluginsRoot, "package.json"),
		JSON.stringify({
			name: "omp-plugins-root",
			version: "0.0.0",
			dependencies: { loom: "1.0.0" },
		}),
	);
	await fs.writeFile(path.join(pluginRoot, "agents", "loom-verify-spec.md"), OMP_PLUGIN_AGENT_MD);
}

describe("discoverAgents", () => {
	let tempHome: string;
	let projectDir: string;

	beforeEach(async () => {
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-task-agent-discovery-"));
		projectDir = path.join(tempHome, "project");
		await fs.mkdir(projectDir, { recursive: true });
	});

	afterEach(async () => {
		enableProvider("omp-plugins");
		clearOmpExtensionCliRoots();
		clearClaudePluginRootsCache();
		clearFsCache();
		await removeWithRetries(tempHome);
	});

	test("loads OMP agents but skips Claude Code custom agents", async () => {
		await fs.mkdir(path.join(projectDir, ".omp", "agents"), { recursive: true });
		await fs.writeFile(path.join(projectDir, ".omp", "agents", "omp-test-agent.md"), OMP_AGENT_MD);

		await fs.mkdir(path.join(tempHome, ".claude", "agents"), { recursive: true });
		await fs.writeFile(path.join(tempHome, ".claude", "agents", "user-cc-test-agent.md"), CLAUDE_AGENT_MD);
		await fs.mkdir(path.join(projectDir, ".claude", "agents"), { recursive: true });
		await fs.writeFile(path.join(projectDir, ".claude", "agents", "project-cc-test-agent.md"), CLAUDE_AGENT_MD);

		const { agents, projectAgentsDir } = await discoverAgents(projectDir, tempHome);
		const names = agents.map(agent => agent.name);

		expect(names).toContain("omp-test-agent");
		expect(names).not.toContain("cc-test-agent");
		expect(projectAgentsDir).toBe(path.join(projectDir, ".omp", "agents"));
	});

	test("loads agents from OMP npm plugins under <home>/.omp/plugins/node_modules", async () => {
		await writeOmpPluginAgent(tempHome);

		const { agents } = await discoverAgents(projectDir, tempHome);
		const names = agents.map(agent => agent.name);

		expect(names).toContain("loom-verify-spec");
	});

	test("excludes OMP npm plugin agents when omp-plugins is disabled", async () => {
		await writeOmpPluginAgent(tempHome);
		disableProvider("omp-plugins");

		const { agents } = await discoverAgents(projectDir, tempHome);
		const names = agents.map(agent => agent.name);

		expect(names).not.toContain("loom-verify-spec");
	});

	test("includeExtensions: false skips extension-package and Claude plugin agent roots", async () => {
		// OMP extension-package fixture: npm plugin under <home>/.omp/plugins/node_modules
		await writeOmpPluginAgent(tempHome);

		// Claude marketplace plugin fixture
		const pluginInstallPath = path.join(tempHome, "plugin-cache", "code-simplifier");
		await fs.mkdir(path.join(pluginInstallPath, "agents"), { recursive: true });
		await fs.writeFile(path.join(pluginInstallPath, "agents", "simplifier.md"), PLUGIN_AGENT_MD);
		const claudePluginsDir = path.join(tempHome, ".claude", "plugins");
		await fs.mkdir(claudePluginsDir, { recursive: true });
		await fs.writeFile(
			path.join(claudePluginsDir, "installed_plugins.json"),
			JSON.stringify({
				version: 2,
				plugins: {
					"code-simplifier@claude-plugins-official": [
						{
							installPath: pluginInstallPath,
							version: "1.0.0",
							scope: "user",
							installedAt: "2025-01-01T00:00:00Z",
							lastUpdated: "2025-01-01T00:00:00Z",
						},
					],
				},
			}),
		);
		clearClaudePluginRootsCache();

		// Project agent must still resolve
		await fs.mkdir(path.join(projectDir, ".omp", "agents"), { recursive: true });
		await fs.writeFile(path.join(projectDir, ".omp", "agents", "omp-test-agent.md"), OMP_AGENT_MD);

		// Sanity: default discovery still surfaces both extension agents
		const withExtensions = await discoverAgents(projectDir, tempHome);
		expect(withExtensions.agents.map(a => a.name)).toEqual(
			expect.arrayContaining(["loom-verify-spec", "simplifier"]),
		);

		// Contract: includeExtensions: false excludes both extension roots while
		// project and bundled agents still resolve
		const { agents } = await discoverAgents(projectDir, tempHome, { includeExtensions: false });
		const names = agents.map(agent => agent.name);
		expect(names).not.toContain("loom-verify-spec");
		expect(names).not.toContain("simplifier");
		expect(names).toContain("omp-test-agent");
		expect(names).toContain("task");
		expect(names).toContain("sonic");
	});

	test("CLI extension agents win over project `extensions:` settings on dedup", async () => {
		// listOmpExtensionRoots returns roots in source-precedence order
		// (CLI > project settings > user settings > installed plugins). Agents
		// must honor that order so the `task` surface dedups identically to
		// the skills/hooks/tools surface in discovery/omp-plugins.ts.
		const cliExt = path.join(tempHome, "cli-ext");
		const projectExt = path.join(tempHome, "project-ext");
		await fs.mkdir(path.join(cliExt, "agents"), { recursive: true });
		await fs.mkdir(path.join(projectExt, "agents"), { recursive: true });
		await fs.writeFile(
			path.join(cliExt, "agents", "collide.md"),
			["---", "name: collide", "description: from-cli", "---", "cli body"].join("\n"),
		);
		await fs.writeFile(
			path.join(projectExt, "agents", "collide.md"),
			["---", "name: collide", "description: from-project-settings", "---", "project body"].join("\n"),
		);

		await fs.mkdir(path.join(projectDir, ".omp"), { recursive: true });
		await fs.writeFile(path.join(projectDir, ".omp", "settings.json"), JSON.stringify({ extensions: [projectExt] }));
		injectOmpExtensionCliRoots([cliExt], tempHome, projectDir);

		const { agents } = await discoverAgents(projectDir, tempHome);
		const collide = agents.find(agent => agent.name === "collide");

		expect(collide).toBeDefined();
		expect(collide?.description).toBe("from-cli");
		expect(collide?.filePath).toBe(path.join(cliExt, "agents", "collide.md"));
	});

	test("explicit-only CLI roots expose only explicitly named package agents", async () => {
		const staleExt = path.join(tempHome, "stale-ext");
		const explicitExt = path.join(tempHome, "explicit-ext");
		const settingsExt = path.join(tempHome, "settings-ext");
		for (const [root, name] of [
			[staleExt, "stale-agent"],
			[explicitExt, "explicit-agent"],
			[settingsExt, "settings-agent"],
		] as const) {
			await fs.mkdir(path.join(root, "agents"), { recursive: true });
			await fs.writeFile(
				path.join(root, "agents", `${name}.md`),
				["---", `name: ${name}`, `description: ${name}`, "---", `${name} body`].join("\n"),
			);
		}
		await fs.mkdir(path.join(projectDir, ".omp"), { recursive: true });
		await fs.writeFile(path.join(projectDir, ".omp", "settings.json"), JSON.stringify({ extensions: [settingsExt] }));
		await writeOmpPluginAgent(tempHome);

		injectOmpExtensionCliRoots([staleExt], tempHome, projectDir);
		injectOmpExtensionCliRoots([explicitExt], tempHome, projectDir, {
			mode: "explicit-only",
			replace: true,
		});

		const { agents } = await discoverAgents(projectDir, tempHome);
		const names = agents.map(agent => agent.name);

		expect(names).toContain("explicit-agent");
		expect(names).not.toEqual(expect.arrayContaining(["stale-agent", "settings-agent", "loom-verify-spec"]));
	});

	test("explicit-only extension mode keeps CLI roots but drops market plugins under includeExtensions: false", async () => {
		const explicitExt = path.join(tempHome, "explicit-ext");
		await fs.mkdir(path.join(explicitExt, "agents"), { recursive: true });
		await fs.writeFile(
			path.join(explicitExt, "agents", "explicit-agent.md"),
			["---", "name: explicit-agent", "description: explicitly requested", "---", "body"].join("\n"),
		);
		injectOmpExtensionCliRoots([explicitExt], tempHome, projectDir, { mode: "explicit-only", replace: true });

		// Claude marketplace plugin fixture — must stay out under explicit-only
		const pluginInstallPath = path.join(tempHome, "plugin-cache", "code-simplifier");
		await fs.mkdir(path.join(pluginInstallPath, "agents"), { recursive: true });
		await fs.writeFile(path.join(pluginInstallPath, "agents", "simplifier.md"), PLUGIN_AGENT_MD);
		const claudePluginsDir = path.join(tempHome, ".claude", "plugins");
		await fs.mkdir(claudePluginsDir, { recursive: true });
		await fs.writeFile(
			path.join(claudePluginsDir, "installed_plugins.json"),
			JSON.stringify({
				version: 2,
				plugins: {
					"code-simplifier@claude-plugins-official": [
						{
							installPath: pluginInstallPath,
							version: "1.0.0",
							scope: "user",
							installedAt: "2025-01-01T00:00:00Z",
							lastUpdated: "2025-01-01T00:00:00Z",
						},
					],
				},
			}),
		);
		clearClaudePluginRootsCache();

		const { agents } = await discoverAgents(projectDir, tempHome, {
			includeExtensions: true,
			extensionMode: "explicit-only",
		});
		const names = agents.map(agent => agent.name);

		expect(names).toContain("explicit-agent");
		expect(names).not.toContain("simplifier");
	});

	test("explicit-only extensionMode option suppresses ambient OMP roots outside the injected scope", async () => {
		// Global injected mode stays "merge": the explicit-only signal must come
		// from the discovery call's own extensionMode option (dashboard reloads,
		// refreshAgentDiscovery, and structured-subagent preflight run outside
		// the SDK's withOmpExtensionRootScope).
		const ambientExt = path.join(tempHome, "ambient-ext");
		await fs.mkdir(path.join(ambientExt, "agents"), { recursive: true });
		await fs.writeFile(
			path.join(ambientExt, "agents", "ambient-ext-agent.md"),
			["---", "name: ambient-ext-agent", "description: from settings extensions", "---", "body"].join("\n"),
		);
		await fs.mkdir(path.join(projectDir, ".omp"), { recursive: true });
		await fs.writeFile(path.join(projectDir, ".omp", "settings.json"), JSON.stringify({ extensions: [ambientExt] }));
		await writeOmpPluginAgent(tempHome);

		const explicitExt = path.join(tempHome, "explicit-ext");
		await fs.mkdir(path.join(explicitExt, "agents"), { recursive: true });
		await fs.writeFile(
			path.join(explicitExt, "agents", "explicit-agent.md"),
			["---", "name: explicit-agent", "description: explicitly requested", "---", "body"].join("\n"),
		);
		injectOmpExtensionCliRoots([explicitExt], tempHome, projectDir);

		const { agents } = await discoverAgents(projectDir, tempHome, {
			includeExtensions: true,
			extensionMode: "explicit-only",
		});
		const names = agents.map(agent => agent.name);

		expect(names).toContain("explicit-agent");
		// Ambient OMP roots (settings extension + installed plugin) must not
		// surface even though the global injected mode is still "merge".
		expect(names).not.toEqual(expect.arrayContaining(["ambient-ext-agent", "loom-verify-spec"]));
	});

	test("extensionRoots resolves pack agents even when entry files would not", async () => {
		// Codex 3741581909: session.extensionPaths holds ENTRY files
		// (pack/index.ts); discovery roots must be the PACKAGE DIRECTORY
		// (pack/), or listOmpExtensionRoots filters them as non-directories
		// and pack/agents/*.md vanishes at task time.
		const packRoot = path.join(tempHome, "explicit-pack");
		await fs.mkdir(path.join(packRoot, "agents"), { recursive: true });
		await fs.writeFile(
			path.join(packRoot, "agents", "pack-agent.md"),
			["---", "name: pack-agent", "description: from explicit pack agents dir", "---", "body"].join("\n"),
		);

		// Entry-file spelling alone must NOT surface the pack agent: the root
		// lookup filters non-directories.
		const { agents: viaEntry } = await discoverAgents(projectDir, tempHome, {
			includeExtensions: true,
			extensionRoots: [path.join(packRoot, "index.ts")],
		});
		expect(viaEntry.map(agent => agent.name)).not.toContain("pack-agent");

		// Package-root spelling DOES surface it.
		const { agents: viaRoot } = await discoverAgents(projectDir, tempHome, {
			includeExtensions: true,
			extensionRoots: [packRoot],
		});
		expect(viaRoot.map(agent => agent.name)).toContain("pack-agent");
	});
});
