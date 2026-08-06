import { describe, expect, test } from "bun:test";
import type { Skill } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { resolveAgentSkills } from "@oh-my-pi/pi-coding-agent/task/agents";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";

function skill(name: string, hide?: boolean): Skill {
	return {
		name,
		description: `${name} description`,
		filePath: `/skills/${name}/SKILL.md`,
		baseDir: "/skills",
		source: "user",
		...(hide !== undefined ? { hide } : {}),
	};
}

function agent(overrides: Partial<Pick<AgentDefinition, "skills" | "hideSkills" | "unhideSkills">> = {}) {
	return overrides;
}

const listed = (skills: Skill[]): string[] => skills.filter(s => s.hide !== true).map(s => s.name);

describe("resolveAgentSkills", () => {
	test("lists every skill by default when no visibility frontmatter is present", () => {
		const skills = [skill("alpha"), skill("beta"), skill("gamma")];
		const resolved = resolveAgentSkills(skills, agent());
		expect(resolved).toHaveLength(3);
		expect(listed(resolved)).toEqual(["alpha", "beta", "gamma"]);
		expect(resolved[0]).toBe(skills[0]);
	});

	test("allowlist narrows the listing to matching names", () => {
		const skills = [skill("alpha"), skill("beta"), skill("gamma")];
		const resolved = resolveAgentSkills(skills, agent({ skills: ["alpha", "ga*"] }));
		expect(listed(resolved)).toEqual(["alpha", "gamma"]);
		expect(resolved.map(s => s.name)).toEqual(["alpha", "beta", "gamma"]);
	});

	test("empty allowlist lists zero skills but keeps them reachable", () => {
		const skills = [skill("alpha"), skill("beta")];
		const resolved = resolveAgentSkills(skills, agent({ skills: [] }));
		expect(listed(resolved)).toEqual([]);
		expect(resolved).toHaveLength(2);
	});

	test("hideSkills beats an overlapping allowlist", () => {
		const skills = [skill("alpha"), skill("beta")];
		const resolved = resolveAgentSkills(skills, agent({ skills: ["*"], hideSkills: ["beta"] }));
		expect(listed(resolved)).toEqual(["alpha"]);
	});

	test("hideSkills beats unhideSkills on overlap", () => {
		const skills = [skill("alpha", true), skill("beta", true)];
		const resolved = resolveAgentSkills(skills, agent({ hideSkills: ["alpha"], unhideSkills: ["*"] }));
		expect(listed(resolved)).toEqual(["beta"]);
	});

	test("unhideSkills clears source hide for matching names", () => {
		const skills = [skill("alpha", true), skill("beta", true)];
		const resolved = resolveAgentSkills(skills, agent({ unhideSkills: ["alpha"] }));
		expect(listed(resolved)).toEqual(["alpha"]);
		expect(resolved[0]?.hide).toBe(false);
		expect(resolved[1]?.hide).toBe(true);
	});

	test("does not copy skills that need no change", () => {
		const skills = [skill("alpha"), skill("beta", true)];
		const resolved = resolveAgentSkills(skills, agent({ hideSkills: ["none"] }));
		expect(resolved[0]).toBe(skills[0]);
		expect(resolved[1]).toBe(skills[1]);
	});

	test("malformed glob does not throw and does not match", () => {
		const skills = [skill("alpha")];
		const resolved = resolveAgentSkills(skills, agent({ hideSkills: ["[invalid"] }));
		expect(listed(resolved)).toEqual(["alpha"]);
		expect(resolved[0]).toBe(skills[0]);
	});
});
