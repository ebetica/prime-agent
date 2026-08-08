import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { createEventBus } from "../src/core/event-bus.js";
import { ExtensionRunner } from "../src/core/extensions/runner.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { DefaultResourceLoader } from "../src/core/resource-loader.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import type { Skill } from "../src/core/skills.js";
import { createSyntheticSourceInfo } from "../src/core/source-info.js";

describe("DefaultResourceLoader", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;
	let previousSerperApiKey: string | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `rl-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		previousSerperApiKey = process.env.SERPER_API_KEY;
		delete process.env.SERPER_API_KEY;
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		if (previousSerperApiKey === undefined) {
			delete process.env.SERPER_API_KEY;
		} else {
			process.env.SERPER_API_KEY = previousSerperApiKey;
		}
		rmSync(tempDir, { recursive: true, force: true });
	});

	describe("reload", () => {
		it("should initialize with empty results before reload", () => {
			const loader = new DefaultResourceLoader({ cwd, agentDir });

			expect(loader.getExtensions().extensions).toEqual([]);
			expect(loader.getSkills().skills).toEqual([]);
			expect(loader.getPrompts().prompts).toEqual([]);
			expect(loader.getThemes().themes).toEqual([]);
		});

		it("should discover skills from agentDir", async () => {
			const skillsDir = join(agentDir, "skills");
			mkdirSync(skillsDir, { recursive: true });
			writeFileSync(
				join(skillsDir, "test-skill.md"),
				`---
name: test-skill
description: A test skill
---
Skill content here.`,
			);

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			const { skills } = loader.getSkills();
			expect(skills.some((s) => s.name === "test-skill")).toBe(true);
		});

		it("should ignore extra markdown files in auto-discovered skill dirs", async () => {
			const skillDir = join(agentDir, "skills", "pi-skills", "browser-tools");
			mkdirSync(skillDir, { recursive: true });
			writeFileSync(
				join(skillDir, "SKILL.md"),
				`---
name: browser-tools
description: Browser tools
---
Skill content here.`,
			);
			writeFileSync(join(skillDir, "EFFICIENCY.md"), "No frontmatter here");

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			const { skills, diagnostics } = loader.getSkills();
			expect(skills.some((s) => s.name === "browser-tools")).toBe(true);
			expect(diagnostics.some((d) => d.path?.endsWith("EFFICIENCY.md"))).toBe(false);
		});

		it("should discover prompts from agentDir", async () => {
			const promptsDir = join(agentDir, "prompts");
			mkdirSync(promptsDir, { recursive: true });
			writeFileSync(
				join(promptsDir, "test-prompt.md"),
				`---
description: A test prompt
---
Prompt content.`,
			);

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			const { prompts } = loader.getPrompts();
			expect(prompts.some((p) => p.name === "test-prompt")).toBe(true);
		});

		it("should prefer project resources over user on name collisions", async () => {
			const userPromptsDir = join(agentDir, "prompts");
			const projectPromptsDir = join(cwd, ".prime", "agent", "prompts");
			mkdirSync(userPromptsDir, { recursive: true });
			mkdirSync(projectPromptsDir, { recursive: true });
			const userPromptPath = join(userPromptsDir, "commit.md");
			const projectPromptPath = join(projectPromptsDir, "commit.md");
			writeFileSync(userPromptPath, "User prompt");
			writeFileSync(projectPromptPath, "Project prompt");

			const userSkillDir = join(agentDir, "skills", "collision-skill");
			const projectSkillDir = join(cwd, ".prime", "agent", "skills", "collision-skill");
			mkdirSync(userSkillDir, { recursive: true });
			mkdirSync(projectSkillDir, { recursive: true });
			const userSkillPath = join(userSkillDir, "SKILL.md");
			const projectSkillPath = join(projectSkillDir, "SKILL.md");
			writeFileSync(
				userSkillPath,
				`---
name: collision-skill
description: user
---
User skill`,
			);
			writeFileSync(
				projectSkillPath,
				`---
name: collision-skill
description: project
---
Project skill`,
			);

			const baseTheme = JSON.parse(
				readFileSync(join(process.cwd(), "src", "modes", "interactive", "theme", "dark.json"), "utf-8"),
			) as { name: string; vars?: Record<string, string> };
			baseTheme.name = "collision-theme";
			const userThemePath = join(agentDir, "themes", "collision.json");
			const projectThemePath = join(cwd, ".prime", "agent", "themes", "collision.json");
			mkdirSync(join(agentDir, "themes"), { recursive: true });
			mkdirSync(join(cwd, ".prime", "agent", "themes"), { recursive: true });
			writeFileSync(userThemePath, JSON.stringify(baseTheme, null, 2));
			if (baseTheme.vars) {
				baseTheme.vars.accent = "#ff00ff";
			}
			writeFileSync(projectThemePath, JSON.stringify(baseTheme, null, 2));

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			const prompt = loader.getPrompts().prompts.find((p) => p.name === "commit");
			expect(prompt?.filePath).toBe(projectPromptPath);

			const skill = loader.getSkills().skills.find((s) => s.name === "collision-skill");
			expect(skill?.filePath).toBe(projectSkillPath);

			const theme = loader.getThemes().themes.find((t) => t.name === "collision-theme");
			expect(theme?.sourcePath).toBe(projectThemePath);
		});

		it("should load symlinked user and project extensions once", async () => {
			const sharedExtDir = join(tempDir, "shared-extensions");
			mkdirSync(sharedExtDir, { recursive: true });
			writeFileSync(
				join(sharedExtDir, "shared.ts"),
				`export default function(pi) {
	pi.registerCommand("shared", {
		description: "shared command",
		handler: async () => {},
	});
}`,
			);

			mkdirSync(agentDir, { recursive: true });
			mkdirSync(join(cwd, ".prime", "agent"), { recursive: true });
			symlinkSync(sharedExtDir, join(agentDir, "extensions"), "dir");
			symlinkSync(sharedExtDir, join(cwd, ".prime", "agent", "extensions"), "dir");

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			const extensionsResult = loader.getExtensions();
			expect(extensionsResult.extensions).toHaveLength(1);
			expect(extensionsResult.errors).toEqual([]);

			// mergePaths processes project paths before user paths, so the project
			// alias is the canonical survivor.
			expect(extensionsResult.extensions[0].path).toBe(join(cwd, ".prime", "agent", "extensions", "shared.ts"));
		});

		it("should keep both extensions loaded when command names collide", async () => {
			const userExtDir = join(agentDir, "extensions");
			const projectExtDir = join(cwd, ".prime", "agent", "extensions");
			mkdirSync(userExtDir, { recursive: true });
			mkdirSync(projectExtDir, { recursive: true });

			writeFileSync(
				join(projectExtDir, "project.ts"),
				`export default function(pi) {
	pi.registerCommand("deploy", {
		description: "project deploy",
		handler: async () => {},
	});
	pi.registerCommand("project-only", {
		description: "project only",
		handler: async () => {},
	});
}`,
			);

			writeFileSync(
				join(userExtDir, "user.ts"),
				`export default function(pi) {
	pi.registerCommand("deploy", {
		description: "user deploy",
		handler: async () => {},
	});
	pi.registerCommand("user-only", {
		description: "user only",
		handler: async () => {},
	});
}`,
			);

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			const extensionsResult = loader.getExtensions();
			expect(extensionsResult.extensions).toHaveLength(2);
			expect(extensionsResult.errors.some((e) => e.error.includes('Command "/deploy" conflicts'))).toBe(false);

			const sessionManager = SessionManager.inMemory();
			const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
			const modelRegistry = ModelRegistry.create(authStorage);
			const runner = new ExtensionRunner(
				extensionsResult.extensions,
				extensionsResult.runtime,
				cwd,
				sessionManager,
				modelRegistry,
			);

			expect(runner.getCommand("deploy:1")?.description).toBe("project deploy");
			expect(runner.getCommand("deploy:2")?.description).toBe("user deploy");
			expect(runner.getCommand("project-only")?.description).toBe("project only");
			expect(runner.getCommand("user-only")?.description).toBe("user only");

			const commands = runner.getRegisteredCommands();
			expect(commands.map((command) => command.invocationName)).toEqual([
				"deploy:1",
				"project-only",
				"deploy:2",
				"user-only",
			]);
		});

		it("should honor overrides for auto-discovered resources", async () => {
			const settingsManager = SettingsManager.inMemory();
			settingsManager.setExtensionPaths(["-extensions/disabled.ts"]);
			settingsManager.setSkillPaths(["-skills/skip-skill"]);
			settingsManager.setPromptTemplatePaths(["-prompts/skip.md"]);
			settingsManager.setThemePaths(["-themes/skip.json"]);

			const extensionsDir = join(agentDir, "extensions");
			mkdirSync(extensionsDir, { recursive: true });
			writeFileSync(join(extensionsDir, "disabled.ts"), "export default function() {}");

			const skillDir = join(agentDir, "skills", "skip-skill");
			mkdirSync(skillDir, { recursive: true });
			writeFileSync(
				join(skillDir, "SKILL.md"),
				`---
name: skip-skill
description: Skip me
---
Content`,
			);

			const promptsDir = join(agentDir, "prompts");
			mkdirSync(promptsDir, { recursive: true });
			writeFileSync(join(promptsDir, "skip.md"), "Skip prompt");

			const themesDir = join(agentDir, "themes");
			mkdirSync(themesDir, { recursive: true });
			writeFileSync(join(themesDir, "skip.json"), "{}");

			const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
			await loader.reload();

			const { extensions } = loader.getExtensions();
			const { skills } = loader.getSkills();
			const { prompts } = loader.getPrompts();
			const { themes } = loader.getThemes();

			expect(extensions.some((e) => e.path.endsWith("disabled.ts"))).toBe(false);
			expect(skills.some((s) => s.name === "skip-skill")).toBe(false);
			expect(prompts.some((p) => p.name === "skip")).toBe(false);
			expect(themes.some((t) => t.sourcePath?.endsWith("skip.json"))).toBe(false);
		});

		it("should discover AGENTS.md context files", async () => {
			writeFileSync(join(cwd, "AGENTS.md"), "# Project Guidelines\n\nBe helpful.");

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			const { agentsFiles } = loader.getAgentsFiles();
			expect(agentsFiles.some((f) => f.path.includes("AGENTS.md"))).toBe(true);
		});

		it("rescans additional context directories on every reload", async () => {
			const contextDir = join(tempDir, "operator-context");
			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				additionalContextDirectories: ["../operator-context", "../missing"],
			});

			await loader.reload();
			expect(loader.getAgentsFiles().agentsFiles).toEqual([]);

			mkdirSync(contextDir);
			writeFileSync(join(cwd, "AGENTS.md"), "project");
			writeFileSync(join(contextDir, "AGENTS.md"), "first");
			writeFileSync(join(contextDir, "notes.txt"), "not context");
			await loader.reload();
			expect(loader.getAgentsFiles().agentsFiles).toEqual([
				{ path: join(contextDir, "AGENTS.md"), content: "first" },
				{ path: join(cwd, "AGENTS.md"), content: "project" },
			]);

			rmSync(join(contextDir, "AGENTS.md"));
			writeFileSync(join(contextDir, "RTK.md"), "replacement");
			await loader.reload();
			expect(loader.getAgentsFiles().agentsFiles).toEqual([
				{ path: join(contextDir, "RTK.md"), content: "replacement" },
				{ path: join(cwd, "AGENTS.md"), content: "project" },
			]);

			rmSync(contextDir, { recursive: true });
			await loader.reload();
			expect(loader.getAgentsFiles().agentsFiles).toEqual([{ path: join(cwd, "AGENTS.md"), content: "project" }]);
		});

		it("should skip AGENTS.md and CLAUDE.md discovery when noContextFiles is true", async () => {
			writeFileSync(join(cwd, "AGENTS.md"), "# Project Guidelines\n\nBe helpful.");
			writeFileSync(join(cwd, "CLAUDE.md"), "# Claude Guidelines\n\nBe helpful.");

			const loader = new DefaultResourceLoader({ cwd, agentDir, noContextFiles: true });
			await loader.reload();

			const { agentsFiles } = loader.getAgentsFiles();
			expect(agentsFiles).toEqual([]);
		});

		it("should discover SYSTEM.md from cwd/.pi", async () => {
			const piDir = join(cwd, ".prime", "agent");
			mkdirSync(piDir, { recursive: true });
			writeFileSync(join(piDir, "SYSTEM.md"), "You are a helpful assistant.");

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			expect(loader.getSystemPrompt()).toBe("You are a helpful assistant.");
		});

		it("should discover APPEND_SYSTEM.md", async () => {
			const piDir = join(cwd, ".prime", "agent");
			mkdirSync(piDir, { recursive: true });
			writeFileSync(join(piDir, "APPEND_SYSTEM.md"), "Additional instructions.");

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			expect(loader.getAppendSystemPrompt()).toContain("Additional instructions.");
		});
	});

	describe("extendResources", () => {
		it("should load skills and prompts with extension metadata", async () => {
			const extraSkillDir = join(tempDir, "extra-skills", "extra-skill");
			mkdirSync(extraSkillDir, { recursive: true });
			const skillPath = join(extraSkillDir, "SKILL.md");
			writeFileSync(
				skillPath,
				`---
name: extra-skill
description: Extra skill
---
Extra content`,
			);

			const extraPromptDir = join(tempDir, "extra-prompts");
			mkdirSync(extraPromptDir, { recursive: true });
			const promptPath = join(extraPromptDir, "extra.md");
			writeFileSync(
				promptPath,
				`---
description: Extra prompt
---
Extra prompt content`,
			);

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			loader.extendResources({
				skillPaths: [
					{
						path: extraSkillDir,
						metadata: {
							source: "extension:extra",
							scope: "temporary",
							origin: "top-level",
							baseDir: extraSkillDir,
						},
					},
				],
				promptPaths: [
					{
						path: promptPath,
						metadata: {
							source: "extension:extra",
							scope: "temporary",
							origin: "top-level",
							baseDir: extraPromptDir,
						},
					},
				],
			});

			const { skills } = loader.getSkills();
			const loadedSkill = skills.find((skill) => skill.name === "extra-skill");
			expect(loadedSkill).toBeDefined();
			expect(loadedSkill?.sourceInfo?.source).toBe("extension:extra");
			expect(loadedSkill?.sourceInfo?.path).toBe(skillPath);

			const { prompts } = loader.getPrompts();
			const loadedPrompt = prompts.find((prompt) => prompt.name === "extra");
			expect(loadedPrompt).toBeDefined();
			expect(loadedPrompt?.sourceInfo?.source).toBe("extension:extra");
			expect(loadedPrompt?.sourceInfo?.path).toBe(promptPath);
		});
	});

	describe("noSkills option", () => {
		it("should skip skill discovery when noSkills is true", async () => {
			const skillsDir = join(agentDir, "skills");
			mkdirSync(skillsDir, { recursive: true });
			writeFileSync(
				join(skillsDir, "test-skill.md"),
				`---
name: test-skill
description: A test skill
---
Content`,
			);

			const loader = new DefaultResourceLoader({ cwd, agentDir, noSkills: true });
			await loader.reload();

			const { skills } = loader.getSkills();
			expect(skills).toEqual([]);
		});

		it("should still load additional skill paths when noSkills is true", async () => {
			const customSkillDir = join(tempDir, "custom-skills");
			mkdirSync(customSkillDir, { recursive: true });
			writeFileSync(
				join(customSkillDir, "custom.md"),
				`---
name: custom
description: Custom skill
---
Content`,
			);

			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				noSkills: true,
				additionalSkillPaths: [customSkillDir],
			});
			await loader.reload();

			const { skills } = loader.getSkills();
			expect(skills.some((s) => s.name === "custom")).toBe(true);
		});
	});

	describe("bundled skills", () => {
		it("should load the bundled websearch skill by default", async () => {
			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			const { skills } = loader.getSkills();
			const websearch = skills.find((s) => s.name === "websearch");
			expect(websearch).toBeDefined();
			expect(websearch?.kind).toBe("python");
			if (websearch?.kind === "python") {
				expect(websearch.python.importName).toBe("websearch");
				expect(websearch.python.pyprojectPath.endsWith("pyproject.toml")).toBe(true);
			}
		});

		it("should not emit a SERPER_API_KEY warning when the key is unset", async () => {
			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			const { diagnostics } = loader.getSkills();
			expect(diagnostics.some((d) => d.type === "warning" && d.message.includes("SERPER_API_KEY"))).toBe(false);
		});

		it("should not load the bundled websearch skill when disabled in settings", async () => {
			const settingsManager = SettingsManager.inMemory({ bundledSkills: { websearch: false } });
			const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
			await loader.reload();

			const { skills, diagnostics } = loader.getSkills();
			expect(skills.some((s) => s.name === "websearch")).toBe(false);
			expect(diagnostics.some((d) => d.type === "warning" && d.message.includes("SERPER_API_KEY is not set"))).toBe(
				false,
			);
		});

		it("should not load bundled skills when noSkills is true", async () => {
			const loader = new DefaultResourceLoader({ cwd, agentDir, noSkills: true });
			await loader.reload();

			const { skills } = loader.getSkills();
			expect(skills.some((s) => s.name === "websearch")).toBe(false);
		});

		it("should let a project skill override the bundled websearch skill", async () => {
			const projectSkillDir = join(cwd, ".prime", "agent", "skills", "websearch");
			mkdirSync(projectSkillDir, { recursive: true });
			writeFileSync(
				join(projectSkillDir, "SKILL.md"),
				`---
name: websearch
description: Project-specific web search override.
---
Project override.`,
			);

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			const { skills, diagnostics } = loader.getSkills();
			const websearch = skills.find((s) => s.name === "websearch");
			expect(websearch).toBeDefined();
			expect(websearch?.filePath).toBe(join(projectSkillDir, "SKILL.md"));
			expect(websearch?.kind).toBe("markdown");
			expect(diagnostics.some((d) => d.type === "collision" && d.collision?.name === "websearch")).toBe(true);
			expect(diagnostics.some((d) => d.type === "warning" && d.message.includes("SERPER_API_KEY is not set"))).toBe(
				false,
			);
		});

		it("should let an explicit --skill path override the bundled websearch skill", async () => {
			const customSkillDir = join(tempDir, "custom-websearch", "websearch");
			mkdirSync(customSkillDir, { recursive: true });
			writeFileSync(
				join(customSkillDir, "SKILL.md"),
				`---
name: websearch
description: Explicit web search override.
---
Explicit override.`,
			);

			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				additionalSkillPaths: [customSkillDir],
			});
			await loader.reload();

			const { skills } = loader.getSkills();
			const websearch = skills.find((s) => s.name === "websearch");
			expect(websearch).toBeDefined();
			expect(websearch?.filePath).toBe(join(customSkillDir, "SKILL.md"));
			expect(websearch?.kind).toBe("markdown");
		});
	});

	describe("override functions", () => {
		it("should apply skillsOverride", async () => {
			const injectedSkill: Skill = {
				name: "injected",
				description: "Injected skill",
				filePath: "/fake/path",
				baseDir: "/fake",
				sourceInfo: createSyntheticSourceInfo("/fake/path", { source: "custom" }),
				disableModelInvocation: false,
				kind: "markdown",
			};
			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				skillsOverride: () => ({
					skills: [injectedSkill],
					diagnostics: [],
				}),
			});
			await loader.reload();

			const { skills } = loader.getSkills();
			expect(skills).toHaveLength(1);
			expect(skills[0].name).toBe("injected");
		});

		it("should apply systemPromptOverride", async () => {
			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				systemPromptOverride: () => "Custom system prompt",
			});
			await loader.reload();

			expect(loader.getSystemPrompt()).toBe("Custom system prompt");
		});
	});

	describe("extension conflict detection", () => {
		it("should detect tool conflicts between extensions", async () => {
			// Create two extensions that register the same tool
			const ext1Dir = join(agentDir, "extensions", "ext1");
			const ext2Dir = join(agentDir, "extensions", "ext2");
			mkdirSync(ext1Dir, { recursive: true });
			mkdirSync(ext2Dir, { recursive: true });

			writeFileSync(
				join(ext1Dir, "index.ts"),
				`
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
export default function(pi: ExtensionAPI) {
  pi.registerTool({
    name: "duplicate-tool",
    description: "First",
    parameters: Type.Object({}),
    execute: async () => ({ result: "1" }),
  });
}`,
			);

			writeFileSync(
				join(ext2Dir, "index.ts"),
				`
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
export default function(pi: ExtensionAPI) {
  pi.registerTool({
    name: "duplicate-tool",
    description: "Second",
    parameters: Type.Object({}),
    execute: async () => ({ result: "2" }),
  });
}`,
			);

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			const { errors } = loader.getExtensions();
			expect(errors.some((e) => e.error.includes("duplicate-tool") && e.error.includes("conflicts"))).toBe(true);
		});

		it("should prefer explicit CLI extensions over discovered extensions when commands and tools conflict", async () => {
			const globalExtDir = join(agentDir, "extensions");
			mkdirSync(globalExtDir, { recursive: true });
			const explicitExtPath = join(tempDir, "explicit-extension.ts");

			writeFileSync(
				join(globalExtDir, "global.ts"),
				`
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
export default function(pi: ExtensionAPI) {
  pi.registerTool({
    name: "duplicate-tool",
    description: "global tool",
    parameters: Type.Object({}),
    execute: async () => ({ result: "global" }),
  });
  pi.registerCommand("deploy", {
    description: "global command",
    handler: async () => {},
  });
}`,
			);

			writeFileSync(
				explicitExtPath,
				`
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
export default function(pi: ExtensionAPI) {
  pi.registerTool({
    name: "duplicate-tool",
    description: "explicit tool",
    parameters: Type.Object({}),
    execute: async () => ({ result: "explicit" }),
  });
  pi.registerCommand("deploy", {
    description: "explicit command",
    handler: async () => {},
  });
}`,
			);

			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				additionalExtensionPaths: [explicitExtPath],
			});
			await loader.reload();

			const extensionsResult = loader.getExtensions();
			expect(extensionsResult.extensions[0]?.path).toBe(explicitExtPath);

			const sessionManager = SessionManager.inMemory();
			const authStorage = AuthStorage.create(join(tempDir, "auth-explicit.json"));
			const modelRegistry = ModelRegistry.create(authStorage);
			const runner = new ExtensionRunner(
				extensionsResult.extensions,
				extensionsResult.runtime,
				cwd,
				sessionManager,
				modelRegistry,
			);

			expect(runner.getCommand("deploy:1")?.description).toBe("explicit command");
			expect(runner.getCommand("deploy:2")?.description).toBe("global command");
			expect(runner.getToolDefinition("duplicate-tool")?.description).toBe("explicit tool");
		});
	});

	describe("atomic resource replacement", () => {
		it("publishes replacement context roots only on commit and preserves them on ordinary reload", async () => {
			const first = join(tempDir, "first-context");
			const second = join(tempDir, "second-context");
			mkdirSync(first);
			mkdirSync(second);
			writeFileSync(join(first, "FIRST.md"), "first sentinel");
			writeFileSync(join(second, "SECOND.md"), "second sentinel");
			const loader = new DefaultResourceLoader({ cwd, agentDir, additionalContextDirectories: [first] });
			await loader.reload();
			expect(loader.getAgentsFiles().agentsFiles.map((entry) => entry.content)).toContain("first sentinel");

			const prepared = await loader.prepareReload({ contextDirectories: [second] });
			expect(loader.getAgentsFiles().agentsFiles.map((entry) => entry.content)).toContain("first sentinel");
			const rollback = prepared.commit();
			expect(loader.getAgentsFiles().agentsFiles.map((entry) => entry.content)).toContain("second sentinel");
			expect(loader.getAgentsFiles().agentsFiles.map((entry) => entry.content)).not.toContain("first sentinel");
			await loader.reload();
			expect(loader.getAgentsFiles().agentsFiles.map((entry) => entry.content)).toContain("second sentinel");
			rollback();
			expect(loader.getAgentsFiles().agentsFiles.map((entry) => entry.content)).toContain("first sentinel");
		});

		it("accepts missing roots, canonicalizes duplicates, and discovers later additions", async () => {
			const missing = join(tempDir, "future-context");
			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();
			const prepared = await loader.prepareReload({ contextDirectories: [missing, missing] });
			expect(prepared.resources.contextDirectories).toEqual([missing]);
			prepared.commit();
			mkdirSync(missing);
			writeFileSync(join(missing, "LATER.md"), "later sentinel");
			await loader.reload();
			expect(loader.getAgentsFiles().agentsFiles.map((entry) => entry.content)).toContain("later sentinel");
		});

		it("keeps every published resource unchanged when candidate loading fails", async () => {
			const stable = join(tempDir, "stable-candidate-context");
			mkdirSync(stable);
			writeFileSync(join(stable, "STABLE.md"), "stable candidate sentinel");
			let failCandidate = false;
			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				additionalContextDirectories: [stable],
				extensionsOverride: (base) => {
					if (failCandidate) throw new Error("candidate load failed");
					return base;
				},
			});
			await loader.reload();
			const previousExtensions = loader.getExtensions();
			const previousAgentsFiles = loader.getAgentsFiles();
			failCandidate = true;
			await expect(loader.prepareReload({ contextDirectories: [] })).rejects.toThrow("candidate load failed");
			expect(loader.getExtensions()).toBe(previousExtensions);
			expect(loader.getAgentsFiles()).toEqual(previousAgentsFiles);
		});

		it("adopts candidate event subscriptions and retires the previous scope only on finalize", async () => {
			const eventBus = createEventBus();
			const observed: number[] = [];
			let generation = 0;
			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				eventBus,
				extensionFactories: [
					(pi) => {
						const loadedGeneration = ++generation;
						pi.events.on("scope-probe", () => observed.push(loadedGeneration));
					},
				],
			});
			await loader.reload();
			const prepared = await loader.prepareReload({ contextDirectories: [] });
			prepared.commit();
			eventBus.emit("scope-probe", undefined);
			expect(observed).toEqual([1]);

			prepared.finalize();
			eventBus.emit("scope-probe", undefined);
			expect(observed).toEqual([1, 2]);
		});

		it("disposes candidate load-time event subscriptions when preparation fails", async () => {
			const eventBus = createEventBus();
			let candidate = false;
			let observed = 0;
			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				eventBus,
				extensionFactories: [
					(pi) => {
						if (candidate) pi.events.on("candidate-probe", () => observed++);
					},
				],
				extensionsOverride: (base) => {
					if (candidate) throw new Error("later candidate failure");
					return base;
				},
			});
			await loader.reload();
			candidate = true;
			await expect(loader.prepareReload({ contextDirectories: [] })).rejects.toThrow("later candidate failure");

			eventBus.emit("candidate-probe", undefined);
			expect(observed).toBe(0);
		});

		it("rejects malformed existing roots without changing published context", async () => {
			const first = join(tempDir, "stable-context");
			const notDirectory = join(tempDir, "not-a-directory");
			mkdirSync(first);
			writeFileSync(join(first, "STABLE.md"), "stable sentinel");
			writeFileSync(notDirectory, "file");
			const loader = new DefaultResourceLoader({ cwd, agentDir, additionalContextDirectories: [first] });
			await loader.reload();
			await expect(loader.prepareReload({ contextDirectories: [notDirectory] })).rejects.toThrow(
				"Context root is not a directory",
			);
			expect(loader.getAgentsFiles().agentsFiles.map((entry) => entry.content)).toContain("stable sentinel");
		});
	});
});
