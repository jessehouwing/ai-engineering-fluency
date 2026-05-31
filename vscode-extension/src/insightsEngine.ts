/**
 * Insights engine — evaluates personalized, data-driven nudges from usage stats.
 *
 * This module is intentionally pure (no VS Code API dependencies) so it can be
 * unit-tested with mocked data following the same pattern as onboarding.ts.
 */
import type {
	UsageAnalysisPeriod,
	MissedPotentialWorkspace,
	WorkspaceCustomizationMatrix,
} from './types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type InsightCategory = 'context' | 'agentic' | 'customization' | 'consistency' | 'tools' | 'trend';
export type InsightSeverity = 'tip' | 'opportunity' | 'celebration';
export type InsightStatus = 'new' | 'seen' | 'dismissed' | 'snoozed' | 'done';

export interface InsightContext {
	today: UsageAnalysisPeriod;
	last30Days: UsageAnalysisPeriod;
	missedPotential: MissedPotentialWorkspace[];
	customizationMatrix?: WorkspaceCustomizationMatrix | null;
}

export interface InsightState {
	status: InsightStatus;
	firstSurfacedAt: string;   // ISO timestamp
	lastSurfacedAt: string;    // ISO timestamp
	snoozeUntil?: string;      // ISO timestamp; present when status === 'snoozed'
}

/** Persisted bag of per-insight state keyed by insight id. */
export type InsightStateBag = Record<string, InsightState>;

/** A fully evaluated, display-ready insight card. */
export interface EvaluatedInsight {
	id: string;
	category: InsightCategory;
	severity: InsightSeverity;
	title: string;
	body: string;
	actionLabel?: string;
	actionCommand?: string;
	status: InsightStatus;
	/** When true, this insight may also be surfaced as a VS Code toast notification. */
	allowToast?: boolean;
}

// ---------------------------------------------------------------------------
// Internal definition shape (not exported — consumers only see EvaluatedInsight)
// ---------------------------------------------------------------------------

interface InsightDefinition {
	id: string;
	category: InsightCategory;
	severity: InsightSeverity;
	title: string;
	buildBody: (ctx: InsightContext) => string;
	actionLabel?: string;
	actionCommand?: string;
	/** Returns true when this insight is applicable given the current context. */
	appliesTo: (ctx: InsightContext) => boolean;
	/** Higher weight → surfaced earlier when multiple insights apply. */
	weight: number;
	allowToast?: boolean;
}

// ---------------------------------------------------------------------------
// Starter catalog
// Sub-session agents will add entries here for trend data, context quality,
// focus times, streaks, and MCP/tool adoption insights.
// ---------------------------------------------------------------------------

export const INSIGHT_CATALOG: InsightDefinition[] = [
	// ── Customization ──────────────────────────────────────────────────────
	{
		id: 'missing-instructions',
		category: 'customization',
		severity: 'opportunity',
		title: '🗒️ Add copilot-instructions.md to your repos',
		buildBody: (ctx) => {
			const count = ctx.missedPotential.length;
			const names = ctx.missedPotential
				.slice(0, 3)
				.map(w => w.workspaceName)
				.join(', ');
			const suffix = count > 3 ? ` (+${count - 3} more)` : '';
			return `${count} active workspace${count > 1 ? 's' : ''} (${names}${suffix}) ${count > 1 ? 'don\'t have' : 'doesn\'t have'} a \`copilot-instructions.md\` file. ` +
				`Adding one gives Copilot project-specific context, reducing back-and-forth and improving response quality.`;
		},
		actionLabel: 'View Workspace Health',
		actionCommand: 'aiEngineeringFluency.showUsageAnalysis',
		appliesTo: (ctx) => ctx.missedPotential.length > 0,
		weight: 90,
		allowToast: true,
	},

	// ── Context ─────────────────────────────────────────────────────────────
	{
		id: 'no-context-refs',
		category: 'context',
		severity: 'tip',
		title: '📎 Try anchoring Copilot with context references',
		buildBody: (ctx) => {
			const sessions = ctx.last30Days.sessions;
			const total = (ctx.last30Days.contextReferences.file ?? 0)
				+ (ctx.last30Days.contextReferences.codebase ?? 0)
				+ (ctx.last30Days.contextReferences.selection ?? 0)
				+ (ctx.last30Days.contextReferences.symbol ?? 0);
			return `Across your ${sessions} sessions in the last 30 days you used only ${total} context ` +
				`reference${total !== 1 ? 's' : ''} (#file, #codebase, @workspace, etc.). ` +
				`Attaching relevant files or symbols helps Copilot give more accurate, targeted answers and reduces follow-up turns.`;
		},
		appliesTo: (ctx) => {
			if (ctx.last30Days.sessions < 10) { return false; }
			const refs = ctx.last30Days.contextReferences;
			const total = (refs.file ?? 0) + (refs.codebase ?? 0)
				+ (refs.selection ?? 0) + (refs.symbol ?? 0);
			return total < 5;
		},
		weight: 70,
	},

	// ── Agentic ─────────────────────────────────────────────────────────────
	{
		id: 'try-agent-mode',
		category: 'agentic',
		severity: 'tip',
		title: '🤖 Try Agent mode for multi-file tasks',
		buildBody: (ctx) => {
			const editCount = ctx.last30Days.modeUsage.edit ?? 0;
			return `You ran ${editCount} edit-mode interaction${editCount !== 1 ? 's' : ''} in the last 30 days but haven't used Agent mode yet. ` +
				`Agent mode lets Copilot autonomously traverse, edit, and test across multiple files — ` +
				`great for refactors, feature additions, or bug hunts that touch more than one file.`;
		},
		appliesTo: (ctx) => {
			if (ctx.last30Days.sessions < 5) { return false; }
			const m = ctx.last30Days.modeUsage;
			return (m.agent ?? 0) === 0 && (m.edit ?? 0) > 3;
		},
		weight: 60,
	},

	// ── Consistency ─────────────────────────────────────────────────────────
	{
		id: 'mostly-single-turn',
		category: 'consistency',
		severity: 'tip',
		title: '🔄 Iterate with Copilot instead of starting fresh',
		buildBody: (ctx) => {
			const { singleTurnSessions, multiTurnSessions } = ctx.last30Days.conversationPatterns;
			const total = singleTurnSessions + multiTurnSessions;
			const pct = total > 0 ? Math.round((singleTurnSessions / total) * 100) : 0;
			return `${pct}% of your last-30-day sessions ended after a single message (${singleTurnSessions} of ${total}). ` +
				`When Copilot's first answer isn't quite right, follow up in the same conversation rather than ` +
				`starting over — it retains context and typically converges faster.`;
		},
		appliesTo: (ctx) => {
			const { singleTurnSessions, multiTurnSessions } = ctx.last30Days.conversationPatterns;
			const total = singleTurnSessions + multiTurnSessions;
			if (total < 10) { return false; }
			return singleTurnSessions / total > 0.80;
		},
		weight: 50,
	},

	// ── Trend ────────────────────────────────────────────────────────────────
	{
		id: 'sessions-trending-up',
		category: 'trend',
		severity: 'celebration',
		title: '🚀 Your Copilot usage is on the rise!',
		buildBody: (ctx) => {
			const dailyAvg = ctx.last30Days.sessions / 30;
			const pct = Math.round((ctx.today.sessions / dailyAvg - 1) * 100);
			return `You've had ${ctx.today.sessions} session${ctx.today.sessions !== 1 ? 's' : ''} today — ` +
				`${pct}% above your daily average of ${dailyAvg.toFixed(1)} over the last 30 days. ` +
				`Great momentum! Keep the streak going.`;
		},
		appliesTo: (ctx) => {
			if (ctx.last30Days.sessions <= 0) { return false; }
			const dailyAvg = ctx.last30Days.sessions / 30;
			return ctx.today.sessions > dailyAvg * 1.3;
		},
		weight: 40,
		allowToast: true,
	},
	{
		id: 'sessions-trending-down',
		category: 'trend',
		severity: 'opportunity',
		title: '💡 No Copilot session yet today',
		buildBody: (_ctx) => {
			return `You haven't started a Copilot session yet today — open a project and let Copilot help.`;
		},
		appliesTo: (ctx) => {
			return ctx.last30Days.sessions > 10 && ctx.today.sessions === 0;
		},
		weight: 55,
	},
	{
		id: 'agent-mode-growth',
		category: 'trend',
		severity: 'celebration',
		title: '🤖 You\'re using Agent mode more — nice!',
		buildBody: (ctx) => {
			const todayTotal = ctx.today.modeUsage.ask + ctx.today.modeUsage.edit + ctx.today.modeUsage.agent;
			const last30Total = ctx.last30Days.modeUsage.ask + ctx.last30Days.modeUsage.edit + ctx.last30Days.modeUsage.agent;
			const todayPct = Math.round((ctx.today.modeUsage.agent / todayTotal) * 100);
			const last30Pct = Math.round((ctx.last30Days.modeUsage.agent / last30Total) * 100);
			return `Agent mode made up ${todayPct}% of your interactions today, up from ${last30Pct}% over the last 30 days. ` +
				`Leaning into Agent mode for complex, multi-file tasks is a sign of growing AI engineering fluency!`;
		},
		appliesTo: (ctx) => {
			if (ctx.last30Days.modeUsage.agent <= 0 || ctx.today.modeUsage.agent <= 0) { return false; }
			const todayTotal = ctx.today.modeUsage.ask + ctx.today.modeUsage.edit + ctx.today.modeUsage.agent;
			const last30Total = ctx.last30Days.modeUsage.ask + ctx.last30Days.modeUsage.edit + ctx.last30Days.modeUsage.agent;
			if (todayTotal <= 0 || last30Total <= 0) { return false; }
			const todayShare = ctx.today.modeUsage.agent / todayTotal;
			const last30Share = ctx.last30Days.modeUsage.agent / last30Total;
			return (todayShare - last30Share) > 0.10;
		},
		weight: 45,
		allowToast: true,
	},
	{
		id: 'context-refs-trending-up',
		category: 'trend',
		severity: 'celebration',
		title: '📎 Your context usage is improving!',
		buildBody: (ctx) => {
			const todayRefs = ctx.today.contextReferences.file + ctx.today.contextReferences.codebase
				+ ctx.today.contextReferences.selection + ctx.today.contextReferences.symbol
				+ ctx.today.contextReferences.workspace + ctx.today.contextReferences.terminal
				+ ctx.today.contextReferences.vscode + ctx.today.contextReferences.implicitSelection;
			const last30Total = ctx.last30Days.contextReferences.file + ctx.last30Days.contextReferences.codebase
				+ ctx.last30Days.contextReferences.selection + ctx.last30Days.contextReferences.symbol
				+ ctx.last30Days.contextReferences.workspace + ctx.last30Days.contextReferences.terminal
				+ ctx.last30Days.contextReferences.vscode + ctx.last30Days.contextReferences.implicitSelection;
			const dailyAvg = last30Total / 30;
			const pct = Math.round((todayRefs / dailyAvg - 1) * 100);
			return `You used ${todayRefs} context reference${todayRefs !== 1 ? 's' : ''} today — ` +
				`${pct}% above your 30-day daily average of ${dailyAvg.toFixed(1)}. ` +
				`Rich context (files, symbols, codebase) helps Copilot give more precise, targeted answers.`;
		},
		appliesTo: (ctx) => {
			const last30Total = ctx.last30Days.contextReferences.file + ctx.last30Days.contextReferences.codebase
				+ ctx.last30Days.contextReferences.selection + ctx.last30Days.contextReferences.symbol
				+ ctx.last30Days.contextReferences.workspace + ctx.last30Days.contextReferences.terminal
				+ ctx.last30Days.contextReferences.vscode + ctx.last30Days.contextReferences.implicitSelection;
			if (last30Total <= 0) { return false; }
			const dailyAvg = last30Total / 30;
			const todayTotal = ctx.today.contextReferences.file + ctx.today.contextReferences.codebase
				+ ctx.today.contextReferences.selection + ctx.today.contextReferences.symbol
				+ ctx.today.contextReferences.workspace + ctx.today.contextReferences.terminal
				+ ctx.today.contextReferences.vscode + ctx.today.contextReferences.implicitSelection;
			return todayTotal > dailyAvg * 1.4;
		},
		weight: 35,
	},
];

// ---------------------------------------------------------------------------
// Core evaluation functions (all pure)
// ---------------------------------------------------------------------------

/** Returns all applicable, non-dismissed insights, sorted by weight descending. */
export function evaluateInsights(
	ctx: InsightContext,
	stateBag: InsightStateBag,
	cadenceDays: number,
	lastNudgeAt: string | null,
): EvaluatedInsight[] {
	const now = new Date().toISOString();
	return INSIGHT_CATALOG
		.filter(def => def.appliesTo(ctx))
		.sort((a, b) => b.weight - a.weight)
		.map(def => {
			const existing = stateBag[def.id];
			const status = resolveStatus(existing, cadenceDays, lastNudgeAt, now);
			return {
				id: def.id,
				category: def.category,
				severity: def.severity,
				title: def.title,
				body: def.buildBody(ctx),
				actionLabel: def.actionLabel,
				actionCommand: def.actionCommand,
				status,
				allowToast: def.allowToast,
			};
		})
		.filter(i => i.status !== 'dismissed');
}

/**
 * Merges newly evaluated insights into the state bag.
 * - Applicable, unseen insights get status 'new'.
 * - Existing states are preserved (seen/snoozed/done/dismissed).
 * - Insights that no longer apply are left in the bag untouched.
 * Returns the updated (mutated) bag.
 */
export function mergeInsightStates(
	evaluated: EvaluatedInsight[],
	stateBag: InsightStateBag,
	now: string,
): InsightStateBag {
	for (const insight of evaluated) {
		const existing = stateBag[insight.id];
		if (!existing) {
			stateBag[insight.id] = {
				status: 'new',
				firstSurfacedAt: now,
				lastSurfacedAt: now,
			};
		} else if (existing.status === 'new' || existing.status === 'seen') {
			// Refresh the lastSurfacedAt timestamp
			existing.lastSurfacedAt = now;
		}
	}
	return stateBag;
}

/** Counts insights with status 'new' (not snoozed, not dismissed). */
export function countNewInsights(stateBag: InsightStateBag, now: string): number {
	return Object.values(stateBag).filter(s => {
		if (s.status !== 'new') { return false; }
		if (s.snoozeUntil && s.snoozeUntil > now) { return false; }
		return true;
	}).length;
}

/**
 * Returns true when a toast notification is allowed.
 * Toast cadence: at most one per cadenceDays days.
 */
export function isToastAllowed(cadenceDays: number, lastNudgeAt: string | null, now: string): boolean {
	if (!lastNudgeAt) { return true; }
	const msSinceLastNudge = new Date(now).getTime() - new Date(lastNudgeAt).getTime();
	const msPerDay = 24 * 60 * 60 * 1000;
	return msSinceLastNudge >= cadenceDays * msPerDay;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function resolveStatus(
	existing: InsightState | undefined,
	cadenceDays: number,
	lastNudgeAt: string | null,
	now: string,
): InsightStatus {
	if (!existing) {
		return 'new';
	}
	// Respect terminal states
	if (existing.status === 'dismissed' || existing.status === 'done') {
		return existing.status;
	}
	// Check snooze expiry
	if (existing.status === 'snoozed') {
		if (existing.snoozeUntil && existing.snoozeUntil <= now) {
			// Snooze expired — resurface
			if (isToastAllowed(cadenceDays, lastNudgeAt, now)) {
				return 'new';
			}
			return 'seen';
		}
		return 'snoozed';
	}
	return existing.status;
}
