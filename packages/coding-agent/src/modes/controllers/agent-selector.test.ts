import { afterEach, describe, expect, test, vi } from "bun:test";
import type { InteractiveModeContext } from "../../modes/types";
import * as discovery from "../../task/discovery";
import { SelectorController } from "./selector-controller";

describe("showAgentPersonaSelector", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	function makeCtx(overrides: Record<string, unknown> = {}): InteractiveModeContext {
		return {
			session: {
				cwd: "/test",
				agentPersona: undefined,
				switchAgentPersona: vi.fn(),
				getExtensionDiscoveryMode: () => "merge" as const,
			},
			sessionManager: {
				getCwd: () => "/test",
			},
			ui: {
				showOverlay: vi.fn(),
				setFocus: vi.fn(),
				requestRender: vi.fn(),
			},
			showStatus: vi.fn(),
			showError: vi.fn(),
			statusLine: { invalidate: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			focusActiveEditorArea: vi.fn(),
			settings: { get: vi.fn() },
			editorContainer: { children: [] },
			editor: {},
			...overrides,
		} as unknown as InteractiveModeContext;
	}

	test("creates picker overlay with filtered agents (no subagent)", async () => {
		const agents = [
			{
				name: "primary",
				description: "",
				systemPrompt: "",
				availability: "primary" as const,
				source: "project" as const,
			},
			{ name: "all", description: "", systemPrompt: "", availability: "all" as const, source: "project" as const },
			{
				name: "sub",
				description: "",
				systemPrompt: "",
				availability: "subagent" as const,
				source: "project" as const,
			},
		];

		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
			agents,
			projectAgentsDir: null,
		});

		const showOverlay = vi.fn();
		const ctx = makeCtx({
			ui: {
				showOverlay,
				setFocus: vi.fn(),
				requestRender: vi.fn(),
			},
		});

		const controller = new SelectorController(ctx);
		await controller.showAgentPersonaSelector();

		expect(showOverlay).toHaveBeenCalledTimes(1);
	});

	test("no selectable agents prints message and does not show overlay", async () => {
		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
			agents: [
				{
					name: "sub",
					description: "",
					systemPrompt: "",
					availability: "subagent" as const,
					source: "project" as const,
				},
			],
			projectAgentsDir: null,
		});

		const showStatus = vi.fn();
		const showOverlay = vi.fn();
		const ctx = makeCtx({
			showStatus,
			ui: {
				showOverlay,
				setFocus: vi.fn(),
				requestRender: vi.fn(),
			},
		});

		const controller = new SelectorController(ctx);
		await controller.showAgentPersonaSelector();

		expect(showStatus).toHaveBeenCalledWith(expect.stringContaining("No selectable"));
		expect(showOverlay).not.toHaveBeenCalled();
	});

	test("selecting an agent calls switchAgentPersona", async () => {
		const agents = [
			{
				name: "test-agent",
				description: "",
				systemPrompt: "",
				availability: "all" as const,
				source: "project" as const,
			},
		];

		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
			agents,
			projectAgentsDir: null,
		});

		const switchAgentPersona = vi.fn().mockResolvedValue(undefined);
		const showOverlay = vi.fn<(...args: unknown[]) => { hide: () => void }>(() => ({ hide: vi.fn() }));
		const ctx = makeCtx({
			session: {
				cwd: "/test",
				agentPersona: undefined,
				switchAgentPersona,
				getExtensionDiscoveryMode: () => "merge" as const,
			},
			ui: {
				showOverlay,
				setFocus: vi.fn(),
				requestRender: vi.fn(),
			},
		});

		const controller = new SelectorController(ctx);
		await controller.showAgentPersonaSelector();

		const picker = (showOverlay.mock.calls[0] as [unknown, unknown])[0];
		await (picker as any).callbacks.onSelect(agents[0]);

		expect(switchAgentPersona).toHaveBeenCalledWith(agents[0]);
	});

	test("cancelling prints cancellation message", async () => {
		const agents = [
			{
				name: "test-agent",
				description: "",
				systemPrompt: "",
				availability: "all" as const,
				source: "project" as const,
			},
		];

		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
			agents,
			projectAgentsDir: null,
		});

		const hide = vi.fn();
		const showOverlay = vi.fn<(...args: unknown[]) => { hide: () => void }>(() => ({ hide }));
		const ctx = makeCtx({
			ui: {
				showOverlay,
				setFocus: vi.fn(),
				requestRender: vi.fn(),
			},
		});

		const controller = new SelectorController(ctx);
		await controller.showAgentPersonaSelector();

		const picker = (showOverlay.mock.calls[0] as [unknown, unknown])[0];
		(picker as any).callbacks.onCancel();

		expect(hide).toHaveBeenCalled();
	});
});
