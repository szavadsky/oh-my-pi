/**
 * Agent persona picker: a bottom-anchored floating overlay listing available
 * agent definitions (excluding subagent-only). The user searches by name and
 * selects one to switch the main-session persona.
 */
import type { Component, TUI } from "@oh-my-pi/pi-tui";
import { Input } from "@oh-my-pi/pi-tui";
import type { AgentDefinition } from "../../task/types";
import { Ellipsis, replaceTabs, truncateToWidth } from "../../tools/render-utils";
import { theme } from "../theme/theme";
import { matchesSelectDown, matchesSelectUp } from "../utils/keybinding-matchers";
import { bottomBorder, row, topBorder } from "./overlay-box";

/** Fixed chrome rows: top border, status row, footer, bottom border. */
const CHROME_ROWS = 4;
/** Rows for search input + blank + blank + hint. */
const FRAME_ROWS = 4;
/** Minimum rows for the agent list on short terminals. */
const MIN_VISIBLE = 3;
/** Fraction of the terminal height the floating overlay occupies. */
const HEIGHT_FRACTION = 0.4;

const FOOTER_HINT = "\u2191/\u2193 agents \u00b7 Enter select \u00b7 type to search \u00b7 Esc close";

export interface AgentPersonaPickerCallbacks {
	onSelect: (agent: AgentDefinition) => void | Promise<void>;
	onCancel: () => void;
}

/**
 * The /agent (no args) picker component. Hosted as a non-fullscreen
 * bottom-anchored overlay; keyboard-only.
 */
export class AgentPersonaPickerComponent implements Component {
	#tui: TUI;
	#agents: AgentDefinition[];
	#currentAgentName: string | undefined;
	#searchInput: Input;
	#filtered: AgentDefinition[] = [];
	#selectedIndex = 0;
	#callbacks: AgentPersonaPickerCallbacks;

	constructor(
		tui: TUI,
		agents: AgentDefinition[],
		currentAgentName: string | undefined,
		callbacks: AgentPersonaPickerCallbacks,
	) {
		this.#tui = tui;
		this.#agents = agents;
		this.#currentAgentName = currentAgentName;
		this.#callbacks = callbacks;
		this.#filtered = agents;

		this.#searchInput = new Input();
		this.#searchInput.prompt = "";
		this.#searchInput.onSubmit = () => {
			const selected = this.#filtered[this.#selectedIndex];
			if (selected) {
				void this.#callbacks.onSelect(selected);
			}
		};
		this.#searchInput.onEscape = () => {
			this.#callbacks.onCancel();
		};
		this.#searchInput.setUseTerminalCursor(true);
	}

	get callbacks(): AgentPersonaPickerCallbacks {
		return this.#callbacks;
	}

	invalidate(): void {}

	handleInput(data: string): void {
		// Mouse tracking is off outside fullscreen overlays; drop any stray SGR
		// reports instead of feeding them to the search input.
		if (data.startsWith("\x1b[<")) return;

		// Navigation keys
		if (matchesSelectUp(data)) {
			if (this.#selectedIndex > 0) {
				this.#selectedIndex--;
				this.#tui.requestRender();
			}
			return;
		}
		if (matchesSelectDown(data)) {
			if (this.#selectedIndex < this.#filtered.length - 1) {
				this.#selectedIndex++;
				this.#tui.requestRender();
			}
			return;
		}

		// Delegate to search input (handles typing, submit, escape, etc.)
		const prevQuery = this.#searchInput.getValue();
		this.#searchInput.handleInput(data);
		const newQuery = this.#searchInput.getValue();
		if (newQuery !== prevQuery) {
			this.#filterAgents(newQuery);
			this.#tui.requestRender();
		}
	}

	#filterAgents(query: string): void {
		const trimmed = query.trim().toLowerCase();
		if (!trimmed) {
			this.#filtered = this.#agents;
		} else {
			this.#filtered = this.#agents.filter(a => a.name.toLowerCase().includes(trimmed));
		}
		this.#selectedIndex = Math.min(this.#selectedIndex, Math.max(0, this.#filtered.length - 1));
	}

	render(width: number): string[] {
		const termRows = Math.max(16, this.#tui.terminal?.rows || process.stdout.rows || 40);
		const listBudget = Math.floor(termRows * HEIGHT_FRACTION) - CHROME_ROWS - FRAME_ROWS;
		const maxVisible = Math.max(MIN_VISIBLE, listBudget);

		const status = theme.fg("muted", " Select an agent persona");

		const out: string[] = [];
		out.push(topBorder(width, "Switch Agent"));

		// Search input row
		const searchPrompt = theme.fg("dim", "> ");
		const searchValue = this.#searchInput.getValue();
		const searchDisplay = searchValue ? theme.fg("text", searchValue) : theme.fg("dim", "Search agents\u2026");
		out.push(row(`${status}  ${searchPrompt}${searchDisplay}`, width));

		// Agent list
		const start = Math.max(0, this.#selectedIndex - Math.floor(maxVisible / 2));
		const visible = this.#filtered.slice(start, start + maxVisible);
		for (const agent of visible) {
			const isActive = agent.name === this.#currentAgentName;
			const isSelected = agent === this.#filtered[this.#selectedIndex];
			const prefix = isSelected ? theme.fg("accent", " \u25b6 ") : "   ";
			const nameStyle = isActive
				? theme.fg("accent", replaceTabs(agent.name))
				: theme.fg("text", replaceTabs(agent.name));
			const sourceBadge = this.#sourceBadge(agent.source);
			const modelHint = agent.model?.length ? theme.fg("dim", ` [${agent.model.join(", ")}]`) : "";
			const description = agent.description
				? theme.fg(
						"muted",
						` \u2014 ${truncateToWidth(replaceTabs(agent.description), Math.max(1, width - 20), Ellipsis.Unicode)}`,
					)
				: "";
			out.push(row(`${prefix}${nameStyle}${sourceBadge}${modelHint}${description}`, width));
		}

		// Fill remaining space if list is short
		const rendered = visible.length;
		for (let i = rendered; i < maxVisible; i++) {
			out.push(row("", width));
		}

		out.push(row(theme.fg("dim", FOOTER_HINT), width));
		out.push(bottomBorder(width));
		return out;
	}

	#sourceBadge(source: AgentDefinition["source"]): string {
		switch (source) {
			case "bundled":
				return theme.fg("dim", " [built-in]");
			case "user":
				return theme.fg("dim", " [user]");
			case "project":
				return theme.fg("dim", " [project]");
		}
	}
}
