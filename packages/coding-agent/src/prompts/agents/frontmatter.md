---

name: {{jsonStringify name}}
description: {{jsonStringify description}}
{{#if spawns}}spawns: {{jsonStringify spawns}}
{{/if}}{{#if model}}model: {{jsonStringify model}}
{{/if}}{{#if thinkingLevel}}thinking-level: {{jsonStringify thinkingLevel}}
{{/if}}{{#if blocking}}blocking: true
{{/if}}{{#if prewalk}}prewalk: {{jsonStringify prewalk}}
{{/if}}{{#if autoloadSkills}}autoloadSkills: {{jsonStringify autoloadSkills}}
{{/if}}{{#if skills}}skills: {{jsonStringify skills}}
{{/if}}{{#if hideSkills}}hideSkills: {{jsonStringify hideSkills}}
{{/if}}{{#if unhideSkills}}unhideSkills: {{jsonStringify unhideSkills}}
{{/if}}---
{{body}}
