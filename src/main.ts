import * as core from '@actions/core';
import { auditOrg } from './audit/org.js';
import { auditTeams } from './audit/team.js';
import { createContext, UserProbeCache } from './audit/probing.js';
import { restoreActivityCache, runMarkerFromIso, saveActivityCache } from './github/cache.js';
import { buildTeamMap } from './github/teams.js';
import { upsertIssue } from './github/issue.js';
import { parseInputs } from './inputs.js';
import { buildClient } from './octokit.js';
import { renderOrgReport, renderTeamReport, type RenderedReport } from './report.js';
import type { AuditConfig, Octokit } from './types.js';

interface ReportPublication {
	readonly scope: string;
	readonly reportRepo: { readonly owner: string; readonly repo: string };
	readonly inactiveCount: number;
	readonly render: () => RenderedReport;
}

async function publishFindings(
	octokit: Octokit,
	cfg: AuditConfig,
	publication: ReportPublication,
): Promise<string> {
	if (publication.inactiveCount === 0) {
		core.info(`no inactive users found for ${publication.scope}; skipping issue publication`);
		return '';
	}

	const report = publication.render();
	const issue = await upsertIssue(octokit, {
		...publication.reportRepo,
		title: report.title,
		body: report.body,
		labels: report.labels,
		dryRun: cfg.dryRun,
	});
	return issue.url;
}

export async function run(): Promise<void> {
	const cfg = parseInputs();
	core.info(`auditing ${cfg.org} (window: ${cfg.inactivityDays}d, dry-run: ${cfg.dryRun})`);
	const octokit = buildClient(cfg.token);

	// One probe cache shared across the org audit and every team audit, so a
	// member who appears in N audits costs at most one fetchOrgActivity call
	// (and one fetchUserCommentsInOrg call) for the whole run.
	const probeCache = new UserProbeCache(createContext(octokit, cfg));

	// One team discovery pass: yields both the login→teams membership index
	// (for ignore-teams filtering and the org audit's no-team verdict) and the
	// slug→reportRepo map parsed from team descriptions (replaces the old
	// `team-map` config input).
	const discovery = await buildTeamMap(octokit, cfg.org);

	const runMarker = runMarkerFromIso(cfg.now);
	const cacheData = await restoreActivityCache(cfg.org, runMarker);
	// Save in `finally` so a partial failure still persists whatever fresh
	// activity data the run gathered. The next run benefits even on crash.
	try {
		const orgResult = await auditOrg(probeCache, discovery.membership, cacheData);
		core.info(
			`org audit done: ${orgResult.inactive.length}/${orgResult.totalAudited} inactive, ${orgResult.errors.length} errors`,
		);

		core.setOutput('inactive-count', String(orgResult.inactive.length));
		const orgIssueUrl = await publishFindings(octokit, cfg, {
			scope: `organization ${cfg.org}`,
			reportRepo: cfg.reportRepo,
			inactiveCount: orgResult.inactive.length,
			render: () => renderOrgReport(orgResult, cfg),
		});
		core.setOutput('issue-url', orgIssueUrl);

		if (discovery.reportRepos.size === 0) {
			core.info(
				'no teams advertise a `repo:` token in their description; skipping per-team audits',
			);
			return;
		}

		core.info(`running per-team audits for ${discovery.reportRepos.size} teams`);
		const teamResults = await auditTeams(probeCache, discovery, cacheData);
		for (const teamResult of teamResults) {
			await publishFindings(octokit, cfg, {
				scope: `team ${teamResult.slug}`,
				reportRepo: teamResult.reportRepo,
				inactiveCount: teamResult.inactive.length,
				render: () => renderTeamReport(teamResult, cfg),
			});
		}
	} finally {
		await saveActivityCache(cfg.org, runMarker, cacheData);
	}
}
