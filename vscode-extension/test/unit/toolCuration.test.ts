import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
	enumerateRuntimeTools,
	parseMcpJson,
	buildMcpEntriesFromJson,
	discoverSkillEntries,
	analyzeToolCuration,
	type RuntimeToolInfo,
} from '../../src/toolCuration';
import type { UsageAnalysisPeriod } from '../../src/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal UsageAnalysisPeriod with no usage. */
function emptyPeriod(): UsageAnalysisPeriod {
	return {
		sessions: 0,
		toolCalls: { total: 0, byTool: {} },
		modeUsage: { ask: 0, edit: 0, agent: 0, plan: 0, customAgent: 0, cli: 0 },
		contextReferences: {
			file: 0, selection: 0, implicitSelection: 0, symbol: 0, codebase: 0,
			workspace: 0, terminal: 0, vscode: 0, terminalLastCommand: 0,
			terminalSelection: 0, clipboard: 0, changes: 0, outputPanel: 0,
			problemsPanel: 0, pullRequest: 0, codeContextLines: 0, byKind: {}, byPath: {},
			copilotInstructions: 0, agentsMd: 0,
		},
		mcpTools: { total: 0, byServer: {}, byTool: {} },
		modelSwitching: {
			modelsPerSession: [], totalSessions: 0, averageModelsPerSession: 0,
			maxModelsPerSession: 0, minModelsPerSession: 0, switchingFrequency: 0,
			standardModels: [], premiumModels: [], unknownModels: [], mixedTierSessions: 0,
			standardRequests: 0, premiumRequests: 0, unknownRequests: 0, totalRequests: 0,
			lowCostModels: [], mediumCostModels: [], highCostModels: [], mixedCostSessions: 0,
			lowCostRequests: 0, mediumCostRequests: 0, highCostRequests: 0,
		},
		repositories: [], repositoriesWithCustomization: [],
		editScope: { singleFileEdits: 0, multiFileEdits: 0, totalEditedFiles: 0, avgFilesPerSession: 0 },
		applyUsage: { totalApplies: 0, totalCodeBlocks: 0, applyRate: 0 },
		sessionDuration: { totalDurationMs: 0, avgDurationMs: 0, avgFirstProgressMs: 0, avgTotalElapsedMs: 0, avgWaitTimeMs: 0 },
		conversationPatterns: { multiTurnSessions: 0, singleTurnSessions: 0, avgTurnsPerSession: 0, maxTurnsInSession: 0 },
		agentTypes: { editsAgent: 0, defaultAgent: 0, workspaceAgent: 0, other: 0 },
	};
}

/**
 * Redirect HOME/USERPROFILE to an isolated empty temp dir for the duration of `fn`,
 * then restore the originals.  Prevents user-level skill dirs (~/.agents/skills/ etc.)
 * from leaking into workspace-isolation tests.
 */
function withIsolatedHome<T>(fn: () => T): T {
	const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ctt-isolated-home-'));
	const origUserProfile = process.env.USERPROFILE;
	const origHome = process.env.HOME;
	process.env.USERPROFILE = isolatedHome;
	process.env.HOME = isolatedHome;
	try {
		return fn();
	} finally {
		if (origUserProfile === undefined) { delete process.env.USERPROFILE; } else { process.env.USERPROFILE = origUserProfile; }
		if (origHome === undefined) { delete process.env.HOME; } else { process.env.HOME = origHome; }
	}
}

/** Write a minimal mcp.json to the given path (creates parent dirs). */
function writeMcpJson(filePath: string, serverNames: string[]): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const servers: Record<string, { command: string }> = {};
	for (const name of serverNames) {
		servers[name] = { command: `npx ${name}` };
	}
	fs.writeFileSync(filePath, JSON.stringify({ servers }), 'utf8');
}

/** Write a SKILL.md under `<skillsDir>/<skillName>/SKILL.md`. */
function writeSkill(skillsDir: string, skillName: string, description?: string): void {
	const skillDir = path.join(skillsDir, skillName);
	fs.mkdirSync(skillDir, { recursive: true });
	const content = description
		? `description: ${description}\n`
		: `# ${skillName}\n\nSome skill content.\n`;
	fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content, 'utf8');
}

// ---------------------------------------------------------------------------
// enumerateRuntimeTools
// ---------------------------------------------------------------------------

test('enumerateRuntimeTools: maps builtin tools correctly', () => {
	const tools: RuntimeToolInfo[] = [
		{ name: 'github_create_issue', description: 'Create a GitHub issue' },
	];
	const result = enumerateRuntimeTools(tools);
	assert.equal(result.length, 1);
	assert.equal(result[0].source, 'builtin');
	assert.equal(result[0].name, 'github_create_issue');
	assert.equal(result[0].description, 'Create a GitHub issue');
	assert.equal(result[0].server, undefined);
});

test('enumerateRuntimeTools: maps MCP tools and extracts server name', () => {
	const tools: RuntimeToolInfo[] = [
		{ name: 'mcp__my-server__do_thing', description: 'Does a thing' },
	];
	const result = enumerateRuntimeTools(tools);
	assert.equal(result.length, 1);
	assert.equal(result[0].source, 'mcp');
	assert.equal(result[0].server, 'my-server');
});

test('enumerateRuntimeTools: returns empty array for empty input', () => {
	assert.deepEqual(enumerateRuntimeTools([]), []);
});

// ---------------------------------------------------------------------------
// parseMcpJson
// ---------------------------------------------------------------------------

test('parseMcpJson: returns empty array for non-existent file', () => {
	assert.deepEqual(parseMcpJson('/does/not/exist/mcp.json'), []);
});

test('parseMcpJson: parses server names from valid file', () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctt-mcp-'));
	const mcpPath = path.join(tmpDir, 'mcp.json');
	writeMcpJson(mcpPath, ['server-a', 'server-b']);
	const result = parseMcpJson(mcpPath);
	assert.deepEqual(result.sort(), ['server-a', 'server-b']);
});

test('parseMcpJson: returns empty array for file with no servers key', () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctt-mcp-noservers-'));
	const mcpPath = path.join(tmpDir, 'mcp.json');
	fs.writeFileSync(mcpPath, JSON.stringify({ inputs: [] }), 'utf8');
	assert.deepEqual(parseMcpJson(mcpPath), []);
});

test('parseMcpJson: returns empty array for malformed JSON', () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctt-mcp-bad-'));
	const mcpPath = path.join(tmpDir, 'mcp.json');
	fs.writeFileSync(mcpPath, '{ not valid json', 'utf8');
	assert.deepEqual(parseMcpJson(mcpPath), []);
});

// ---------------------------------------------------------------------------
// buildMcpEntriesFromJson — VS Code location (.vscode/mcp.json)
// ---------------------------------------------------------------------------

test('buildMcpEntriesFromJson: discovers servers from .vscode/mcp.json', () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctt-mcp-vscode-'));
	writeMcpJson(path.join(tmpDir, '.vscode', 'mcp.json'), ['vscode-server']);

	const result = buildMcpEntriesFromJson([tmpDir]);

	const names = result.map(e => e.server);
	assert.ok(names.includes('vscode-server'), 'should find .vscode/mcp.json server');
});

// ---------------------------------------------------------------------------
// buildMcpEntriesFromJson — Visual Studio locations
// ---------------------------------------------------------------------------

test('buildMcpEntriesFromJson: discovers servers from .mcp.json (VS repo-root)', () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctt-mcp-vsroot-'));
	writeMcpJson(path.join(tmpDir, '.mcp.json'), ['vs-root-server']);

	const result = buildMcpEntriesFromJson([tmpDir]);

	const names = result.map(e => e.server);
	assert.ok(names.includes('vs-root-server'), 'should find .mcp.json at repo root');
});

test('buildMcpEntriesFromJson: discovers servers from .vs/mcp.json (VS solution-scoped)', () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctt-mcp-vs-'));
	writeMcpJson(path.join(tmpDir, '.vs', 'mcp.json'), ['vs-solution-server']);

	const result = buildMcpEntriesFromJson([tmpDir]);

	const names = result.map(e => e.server);
	assert.ok(names.includes('vs-solution-server'), 'should find .vs/mcp.json server');
});

test('buildMcpEntriesFromJson: discovers servers from .cursor/mcp.json', () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctt-mcp-cursor-'));
	writeMcpJson(path.join(tmpDir, '.cursor', 'mcp.json'), ['cursor-server']);

	const result = buildMcpEntriesFromJson([tmpDir]);

	const names = result.map(e => e.server);
	assert.ok(names.includes('cursor-server'), 'should find .cursor/mcp.json server');
});

test('buildMcpEntriesFromJson: deduplicates servers appearing in multiple config files', () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctt-mcp-dedup-'));
	// Same server name in two locations
	writeMcpJson(path.join(tmpDir, '.vscode', 'mcp.json'), ['shared-server', 'vscode-only']);
	writeMcpJson(path.join(tmpDir, '.mcp.json'), ['shared-server', 'root-only']);

	const result = buildMcpEntriesFromJson([tmpDir]);

	const serverNames = result.map(e => e.server);
	const uniqueNames = new Set(serverNames);
	assert.equal(uniqueNames.size, serverNames.length, 'should not have duplicate servers');
	assert.ok(serverNames.includes('shared-server'));
	assert.ok(serverNames.includes('vscode-only'));
	assert.ok(serverNames.includes('root-only'));
});

test('buildMcpEntriesFromJson: deduplicates across multiple workspace folders', () => {
	const tmpA = fs.mkdtempSync(path.join(os.tmpdir(), 'ctt-mcp-wsa-'));
	const tmpB = fs.mkdtempSync(path.join(os.tmpdir(), 'ctt-mcp-wsb-'));
	writeMcpJson(path.join(tmpA, '.vscode', 'mcp.json'), ['shared', 'only-a']);
	writeMcpJson(path.join(tmpB, '.vscode', 'mcp.json'), ['shared', 'only-b']);

	const result = buildMcpEntriesFromJson([tmpA, tmpB]);

	const serverNames = result.map(e => e.server);
	const unique = [...new Set(serverNames)];
	assert.equal(unique.length, serverNames.length, 'no duplicates across workspace folders');
	assert.equal(serverNames.filter(n => n === 'shared').length, 1);
});

test('buildMcpEntriesFromJson: returns empty array when no config files exist', () => {
	withIsolatedHome(() => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctt-mcp-empty-'));
		assert.deepEqual(buildMcpEntriesFromJson([tmpDir]), []);
	});
});

test('buildMcpEntriesFromJson: result entries have correct shape', () => {
	withIsolatedHome(() => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctt-mcp-shape-'));
		writeMcpJson(path.join(tmpDir, '.vscode', 'mcp.json'), ['my-server']);

		const result = buildMcpEntriesFromJson([tmpDir]);

		assert.equal(result.length, 1);
		assert.equal(result[0].name, 'mcp__my-server');
		assert.equal(result[0].source, 'mcp');
		assert.equal(result[0].server, 'my-server');
		assert.ok(result[0].description.includes('my-server'));
	});
});

// ---------------------------------------------------------------------------
// discoverSkillEntries — VS Code location (.github/skills/)
// ---------------------------------------------------------------------------

test('discoverSkillEntries: discovers skills from .github/skills/', () => {
	withIsolatedHome(() => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctt-skills-github-'));
		writeSkill(path.join(tmpDir, '.github', 'skills'), 'my-skill', 'Does something useful');

		const result = discoverSkillEntries([tmpDir]);

		assert.equal(result.length, 1);
		assert.equal(result[0].name, 'my-skill');
		assert.equal(result[0].source, 'skill');
		assert.ok(result[0].description.includes('Does something useful'));
	});
});

// ---------------------------------------------------------------------------
// discoverSkillEntries — Visual Studio additional workspace locations
// ---------------------------------------------------------------------------

test('discoverSkillEntries: discovers skills from .claude/skills/ (Visual Studio)', () => {
	withIsolatedHome(() => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctt-skills-claude-'));
		writeSkill(path.join(tmpDir, '.claude', 'skills'), 'claude-skill');

		const result = discoverSkillEntries([tmpDir]);

		const names = result.map(s => s.name);
		assert.ok(names.includes('claude-skill'), 'should find .claude/skills/ skill');
	});
});

test('discoverSkillEntries: discovers skills from .agents/skills/ (Visual Studio)', () => {
	withIsolatedHome(() => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctt-skills-agents-'));
		writeSkill(path.join(tmpDir, '.agents', 'skills'), 'agents-skill');

		const result = discoverSkillEntries([tmpDir]);

		const names = result.map(s => s.name);
		assert.ok(names.includes('agents-skill'), 'should find .agents/skills/ skill');
	});
});

test('discoverSkillEntries: discovers skills from all three workspace locations', () => {
	withIsolatedHome(() => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctt-skills-all-'));
		writeSkill(path.join(tmpDir, '.github', 'skills'), 'github-skill');
		writeSkill(path.join(tmpDir, '.claude', 'skills'), 'claude-skill');
		writeSkill(path.join(tmpDir, '.agents', 'skills'), 'agents-skill');

		const result = discoverSkillEntries([tmpDir]);

		const names = result.map(s => s.name);
		assert.ok(names.includes('github-skill'));
		assert.ok(names.includes('claude-skill'));
		assert.ok(names.includes('agents-skill'));
		assert.equal(result.length, 3);
	});
});

test('discoverSkillEntries: deduplicates skills with the same SKILL.md path', () => {
	withIsolatedHome(() => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctt-skills-dedup-'));
		// Same skill name in two different location dirs — different paths, no dedup expected
		writeSkill(path.join(tmpDir, '.github', 'skills'), 'my-skill');
		writeSkill(path.join(tmpDir, '.claude', 'skills'), 'my-skill');

		const result = discoverSkillEntries([tmpDir]);

		// Two different SKILL.md paths, so both are included
		assert.equal(result.filter(s => s.name === 'my-skill').length, 2);
	});
});

test('discoverSkillEntries: deduplicates across multiple workspace folders', () => {
	withIsolatedHome(() => {
		const tmpA = fs.mkdtempSync(path.join(os.tmpdir(), 'ctt-skills-wsa-'));
		const tmpB = fs.mkdtempSync(path.join(os.tmpdir(), 'ctt-skills-wsb-'));
		writeSkill(path.join(tmpA, '.github', 'skills'), 'skill-a');
		writeSkill(path.join(tmpB, '.github', 'skills'), 'skill-b');

		const result = discoverSkillEntries([tmpA, tmpB]);

		const names = result.map(s => s.name);
		assert.ok(names.includes('skill-a'));
		assert.ok(names.includes('skill-b'));
	});
});

test('discoverSkillEntries: returns empty array when no skill dirs exist', () => {
	withIsolatedHome(() => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctt-skills-none-'));
		assert.deepEqual(discoverSkillEntries([tmpDir]), []);
	});
});

test('discoverSkillEntries: ignores entries without SKILL.md', () => {
	withIsolatedHome(() => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctt-skills-nomd-'));
		const skillsDir = path.join(tmpDir, '.github', 'skills');
		// Create a sub-directory but without SKILL.md
		fs.mkdirSync(path.join(skillsDir, 'not-a-skill'), { recursive: true });
		fs.writeFileSync(path.join(skillsDir, 'not-a-skill', 'README.md'), '# not a skill', 'utf8');

		const result = discoverSkillEntries([tmpDir]);

		assert.deepEqual(result, []);
	});
});

test('discoverSkillEntries: extracts description from SKILL.md', () => {
	withIsolatedHome(() => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctt-skills-desc-'));
		writeSkill(path.join(tmpDir, '.github', 'skills'), 'desc-skill', 'This is the skill description');

		const result = discoverSkillEntries([tmpDir]);

		assert.equal(result.length, 1);
		assert.ok(result[0].description.includes('This is the skill description'));
	});
});

test('discoverSkillEntries: falls back to "Skill: <name>" when no description found', () => {
	withIsolatedHome(() => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctt-skills-fallback-'));
		const skillsDir = path.join(tmpDir, '.github', 'skills', 'plain-skill');
		fs.mkdirSync(skillsDir, { recursive: true });
		fs.writeFileSync(path.join(skillsDir, 'SKILL.md'), 'Just some text without a description line.\n', 'utf8');

		const result = discoverSkillEntries([tmpDir]);

		assert.equal(result.length, 1);
		assert.equal(result[0].description, 'Skill: plain-skill');
	});
});

test('discoverSkillEntries: skillPath is relative and uses forward slashes', () => {
	withIsolatedHome(() => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctt-skills-relpath-'));
		writeSkill(path.join(tmpDir, '.github', 'skills'), 'rel-skill');

		const result = discoverSkillEntries([tmpDir]);

		assert.equal(result.length, 1);
		assert.ok(!result[0].skillPath?.includes('\\'), 'skillPath should use forward slashes');
		assert.ok(result[0].skillPath?.startsWith('.github/skills/'));
	});
});

test('discoverSkillEntries: includes user-level skills from home dir', () => {
	withIsolatedHome(() => {
		const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
		// Write a skill under ~/.agents/skills/ in our isolated home
		writeSkill(path.join(home, '.agents', 'skills'), 'user-level-skill', 'A user skill');

		const result = discoverSkillEntries([]); // no workspace folders

		const names = result.map(s => s.name);
		assert.ok(names.includes('user-level-skill'), 'should discover skills from user-level dirs');
	});
});

// ---------------------------------------------------------------------------
// analyzeToolCuration
// ---------------------------------------------------------------------------

test('analyzeToolCuration: flags unused MCP server with disable recommendation', () => {
	const available = [
		{ name: 'mcp__idle-server', description: 'Idle MCP server', source: 'mcp' as const, server: 'idle-server' },
	];
	const period = emptyPeriod();

	const result = analyzeToolCuration(available, period, 30);

	assert.equal(result.unusedTools.length, 1);
	const rec = result.recommendations.find(r => r.type === 'disable-mcp-server');
	assert.ok(rec, 'should have a disable-mcp-server recommendation');
	assert.equal(rec?.target, 'idle-server');
	assert.ok(rec?.reason.includes('30 days'));
});

test('analyzeToolCuration: does not flag used MCP server', () => {
	const available = [
		{ name: 'mcp__active-server', description: 'Active server', source: 'mcp' as const, server: 'active-server' },
	];
	// Tool name in byTool must match the available entry name exactly for usedNames to include it
	const period: UsageAnalysisPeriod = {
		...emptyPeriod(),
		mcpTools: { total: 5, byServer: { 'active-server': 5 }, byTool: { 'mcp__active-server': 5 } },
	};

	const result = analyzeToolCuration(available, period, 30);

	assert.equal(result.unusedTools.length, 0);
	assert.equal(result.recommendations.filter(r => r.type === 'disable-mcp-server').length, 0);
});

test('analyzeToolCuration: flags unused skill with refine recommendation', () => {
	const available = [
		{ name: 'stale-skill', description: 'Stale skill', source: 'skill' as const, skillPath: '.github/skills/stale-skill/SKILL.md' },
	];
	const period = emptyPeriod();

	const result = analyzeToolCuration(available, period, 30);

	const rec = result.recommendations.find(r => r.type === 'refine-skill');
	assert.ok(rec, 'should have a refine-skill recommendation');
	assert.equal(rec?.target, 'stale-skill');
});

test('analyzeToolCuration: includes windowDays in result', () => {
	const result = analyzeToolCuration([], emptyPeriod(), 90);
	assert.equal(result.windowDays, 90);
});

test('analyzeToolCuration: estimatedPromptBloat.totalTokens > 0 for unused tools', () => {
	const available = [
		{ name: 'mcp__idle', description: 'A description long enough to count', source: 'mcp' as const, server: 'idle' },
	];
	const result = analyzeToolCuration(available, emptyPeriod(), 30);
	assert.ok(result.estimatedPromptBloat.totalTokens > 0);
});
