import type { AutocompleteItem } from "@oh-my-pi/pi-tui";
import { COLLAB_GUEST_ALLOWED_COMMANDS } from "../collab/guest";
import { discoverAgents, getAgent } from "../task/discovery";
import { BUILTIN_COLLABORATION_SLASH_COMMANDS } from "./builtin-collaboration";
import {
	buildArgumentCompletions,
	buildDirectoryArgumentCompletions,
	buildMcpArgumentCompletions,
	buildStaticInlineHint,
	buildSubcommandInlineHint,
} from "./builtin-completions";
import { BUILTIN_CONTROL_SLASH_COMMANDS } from "./builtin-control";
import { BUILTIN_LIFECYCLE_SLASH_COMMANDS } from "./builtin-lifecycle";
import { BUILTIN_MARKETPLACE_SLASH_COMMANDS, reloadTuiPluginState } from "./builtin-marketplace";
import { BUILTIN_MODE_SLASH_COMMANDS } from "./builtin-modes";
import { BUILTIN_SESSION_SLASH_COMMANDS } from "./builtin-session";
import { commandConsumed, parseSlashCommand } from "./helpers/parse";
import type {
	BuiltinSlashCommand,
	ParsedSlashCommand,
	SlashCommandResult,
	SlashCommandRuntime,
	SlashCommandSpec,
	TuiSlashCommandRuntime,
} from "./types";

export type { BuiltinSlashCommand, SubcommandDef } from "./types";

/** TUI-specific runtime accepted by `executeBuiltinSlashCommand`. */
export type BuiltinSlashCommandRuntime = TuiSlashCommandRuntime;

export interface TuiBuiltinSlashCommand extends BuiltinSlashCommand {
	getArgumentCompletions?: (prefix: string) => AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>;
	getInlineHint?: (argumentText: string) => string | null;
	getAutocompleteDescription?: () => string | undefined;
}

const BUILTIN_SLASH_COMMAND_REGISTRY: ReadonlyArray<SlashCommandSpec> = [
	...BUILTIN_MODE_SLASH_COMMANDS,
	...BUILTIN_COLLABORATION_SLASH_COMMANDS,
	...BUILTIN_SESSION_SLASH_COMMANDS,
	...BUILTIN_LIFECYCLE_SLASH_COMMANDS,
	...BUILTIN_MARKETPLACE_SLASH_COMMANDS,
	...BUILTIN_CONTROL_SLASH_COMMANDS,
	{
		name: "agent",
		aliases: ["switch-agent"],
		description:
			"Switch to a different agent persona. Use /agent <name> to switch directly, or /agent to open the picker.",
		allowArgs: true,
		inlineHint: "[name]",
		handle: async (command, runtime) => {
			if (runtime.session.isStreaming) {
				await runtime.output("Cannot switch agent while streaming.");
				return commandConsumed();
			}
			if (runtime.session.getPlanModeState()?.enabled) {
				await runtime.output("Cannot switch agent during plan mode. Exit plan mode first.");
				return commandConsumed();
			}
			if (runtime.session.getGoalModeState()?.enabled) {
				await runtime.output("Cannot switch agent during goal mode. Exit goal mode first.");
				return commandConsumed();
			}
			if (runtime.session.getVibeModeState()?.enabled) {
				await runtime.output("Cannot switch agent during vibe mode. Exit vibe mode first.");
				return commandConsumed();
			}
			const agentName = command.args.trim();
			if (!agentName) {
				await runtime.output("Usage: /agent <name>");
				return commandConsumed();
			}

			// Rediscover under the session's extension mode so a --no-extensions
			// session cannot switch to an extension/plugin persona startup suppressed.
			const discovery = await discoverAgents(runtime.cwd, undefined, {
				includeExtensions: true,
				extensionMode: runtime.session.getExtensionDiscoveryMode(),
				extensionRoots: runtime.session.extensionRoots,
			});
			const disabled = new Set((runtime.settings.get("task.disabledAgents") as string[] | undefined) ?? []);
			const agent = getAgent(discovery.agents, agentName);
			if (agent && disabled.has(agent.name)) {
				await runtime.output(`Agent "${agentName}" is disabled in settings (task.disabledAgents).`);
				return commandConsumed();
			}
			if (!agent) {
				const available =
					discovery.agents
						.filter(a => a.availability !== "subagent")
						.map(a => a.name)
						.join(", ") || "none";
				await runtime.output(`Unknown agent "${agentName}". Available: ${available}`);
				return commandConsumed();
			}
			if (agent.availability === "subagent") {
				await runtime.output(`Agent "${agentName}" is subagent-only and cannot be selected as main persona.`);
				return commandConsumed();
			}

			try {
				await runtime.session.switchAgentPersona(agent);
			} catch (error) {
				await runtime.output(`Failed to switch agent: ${error}`);
				return commandConsumed();
			}
			await runtime.output(`Switched to agent persona "${agent.name}".`);
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			if (runtime.ctx.session.isStreaming) {
				runtime.ctx.showWarning("Cannot switch agent while streaming.");
				runtime.ctx.editor.setText("");
				return;
			}
			if (runtime.ctx.planModeEnabled) {
				runtime.ctx.showWarning("Cannot switch agent during plan mode. Exit plan mode first.");
				runtime.ctx.editor.setText("");
				return;
			}
			if (runtime.ctx.goalModeEnabled) {
				runtime.ctx.showWarning("Cannot switch agent during goal mode. Exit goal mode first.");
				runtime.ctx.editor.setText("");
				return;
			}
			if (runtime.ctx.vibeModeEnabled) {
				runtime.ctx.showWarning("Cannot switch agent during vibe mode. Exit vibe mode first.");
				runtime.ctx.editor.setText("");
				return;
			}
			const agentName = command.args.trim();
			if (agentName) {
				const discovery = await discoverAgents(runtime.ctx.sessionManager.getCwd(), undefined, {
					includeExtensions: true,
					extensionMode: runtime.ctx.session.getExtensionDiscoveryMode(),
					extensionRoots: runtime.ctx.session.extensionRoots,
				});
				const disabled = new Set((runtime.ctx.settings.get("task.disabledAgents") as string[] | undefined) ?? []);
				const agent = getAgent(discovery.agents, agentName);
				if (agent && disabled.has(agent.name)) {
					runtime.ctx.showWarning(`Agent "${agentName}" is disabled in settings (task.disabledAgents).`);
					runtime.ctx.editor.setText("");
					return;
				}
				if (!agent) {
					runtime.ctx.showWarning(`Unknown agent "${agentName}".`);
					runtime.ctx.editor.setText("");
					return;
				}
				if (agent.availability === "subagent") {
					runtime.ctx.showWarning(`Agent "${agentName}" is subagent-only.`);
					runtime.ctx.editor.setText("");
					return;
				}
				try {
					await runtime.ctx.session.switchAgentPersona(agent);
				} catch (error) {
					runtime.ctx.showWarning(`Failed to switch agent: ${error}`);
					runtime.ctx.editor.setText("");
					return;
				}
				runtime.ctx.editor.setText("");
				return;
			}

			runtime.ctx.showAgentPersonaSelector();
			runtime.ctx.editor.setText("");
		},
	},
];

const BUILTIN_SLASH_COMMAND_LOOKUP = new Map<string, SlashCommandSpec>();
for (const command of BUILTIN_SLASH_COMMAND_REGISTRY) {
	BUILTIN_SLASH_COMMAND_LOOKUP.set(command.name, command);
	for (const alias of command.aliases ?? []) {
		BUILTIN_SLASH_COMMAND_LOOKUP.set(alias, command);
	}
}

export const BUILTIN_SLASH_COMMAND_RESERVED_NAMES: ReadonlySet<string> = new Set(BUILTIN_SLASH_COMMAND_LOOKUP.keys());

/** Builtin command metadata used for slash-command autocomplete and help text. */
export const BUILTIN_SLASH_COMMAND_DEFS: ReadonlyArray<BuiltinSlashCommand> = BUILTIN_SLASH_COMMAND_REGISTRY.map(
	command => ({
		name: command.name,
		aliases: command.aliases,
		allowArgs: command.allowArgs === true,
		description: command.description,
		subcommands: command.subcommands,
		inlineHint: command.inlineHint,
		getTuiAutocompleteDescription: command.getTuiAutocompleteDescription,
	}),
);

function materializeTuiBuiltinSlashCommand(
	cmd: BuiltinSlashCommand,
	runtime?: TuiSlashCommandRuntime,
): TuiBuiltinSlashCommand {
	const materialized: TuiBuiltinSlashCommand = { ...cmd };
	if (cmd.subcommands) {
		materialized.getArgumentCompletions =
			cmd.name === "mcp" && runtime
				? buildMcpArgumentCompletions(cmd.subcommands, runtime)
				: buildArgumentCompletions(cmd.subcommands);
		materialized.getInlineHint = buildSubcommandInlineHint(cmd.subcommands);
	} else if (cmd.name === "move") {
		materialized.getArgumentCompletions = buildDirectoryArgumentCompletions();
		if (cmd.inlineHint) materialized.getInlineHint = buildStaticInlineHint(cmd.inlineHint);
	} else if (cmd.inlineHint) {
		materialized.getInlineHint = buildStaticInlineHint(cmd.inlineHint);
	}
	if (runtime && cmd.getTuiAutocompleteDescription) {
		materialized.getAutocompleteDescription = () => cmd.getTuiAutocompleteDescription?.(runtime);
	}
	return materialized;
}

/**
 * Materialized builtin slash commands with completion functions derived from
 * declarative subcommand/hint definitions.
 */
export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<TuiBuiltinSlashCommand> = BUILTIN_SLASH_COMMAND_DEFS.map(cmd =>
	materializeTuiBuiltinSlashCommand(cmd),
);

export function buildTuiBuiltinSlashCommands(runtime: TuiSlashCommandRuntime): ReadonlyArray<TuiBuiltinSlashCommand> {
	return BUILTIN_SLASH_COMMAND_DEFS.map(cmd => materializeTuiBuiltinSlashCommand(cmd, runtime));
}

/**
 * Unified registry exposed for cross-mode tooling. Each spec carries at least
 * one of `handle` / `handleTui`. The TUI dispatcher prefers `handleTui`; the
 * ACP dispatcher requires `handle` and skips TUI-only entries.
 */
export const BUILTIN_SLASH_COMMANDS_INTERNAL: ReadonlyArray<SlashCommandSpec> = BUILTIN_SLASH_COMMAND_REGISTRY;

/**
 * Execute a builtin slash command in the interactive TUI.
 *
 * Returns `false` when no builtin matched. Returns `true` when a command
 * consumed the input entirely. Returns a `string` when the command was handled
 * but remaining text should be sent as a prompt.
 */
export async function executeBuiltinSlashCommand(
	text: string,
	runtime: BuiltinSlashCommandRuntime,
): Promise<string | boolean> {
	const parsed = parseSlashCommand(text);
	if (!parsed) return false;

	const command = BUILTIN_SLASH_COMMAND_LOOKUP.get(parsed.name);
	if (!command) return false;
	if (parsed.args.length > 0 && !command.allowArgs) {
		return false;
	}
	// Collab guests run a read-mostly replica: session-mutating builtins are
	// host-only; the allowlist covers purely local/read-only commands.
	if (runtime.ctx.collabGuest && !COLLAB_GUEST_ALLOWED_COMMANDS[command.name]) {
		runtime.ctx.showStatus(`/${command.name} is host-only during a collab session`);
		runtime.ctx.editor.setText("");
		return true;
	}
	if (command.handleTui) {
		const result = await command.handleTui(parsed, runtime);
		if (result && typeof result === "object" && "prompt" in result) return result.prompt;
		return true;
	}
	if (command.handle) {
		// No TUI-specific override → adapt the ACP/text-mode `handle` to the
		// TUI by routing `runtime.output` through `ctx.showStatus`, clearing
		// the editor after the call, and reusing the active session's plugin
		// reload pipeline. Spec authors get a single body usable from either
		// dispatcher without forcing every TUI test to construct the full
		// `SlashCommandRuntime` shape.
		const ctx = runtime.ctx;
		const adapted: SlashCommandRuntime = {
			session: ctx.session,
			sessionManager: ctx.sessionManager,
			settings: ctx.settings,
			cwd: ctx.sessionManager.getCwd(),
			output: (text: string) => {
				ctx.showStatus(text);
			},
			refreshCommands: () => ctx.refreshSlashCommandState(),
			reloadPlugins: () => reloadTuiPluginState(ctx),
		};
		const result = await command.handle(parsed, adapted);
		ctx.editor.setText("");
		if (result && typeof result === "object" && "prompt" in result) return result.prompt;
		return true;
	}
	return false;
}

/** Look up a unified spec by name or alias. Used by the ACP dispatcher. */
export function lookupBuiltinSlashCommand(name: string): SlashCommandSpec | undefined {
	return BUILTIN_SLASH_COMMAND_LOOKUP.get(name);
}

export type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime, SlashCommandSpec, TuiSlashCommandRuntime };
