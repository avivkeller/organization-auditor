import * as core from '@actions/core';
import type { Octokit } from '../types.js';

export interface UpsertParams {
	readonly owner: string;
	readonly repo: string;
	readonly title: string;
	readonly body: string;
	readonly labels: readonly string[];
	readonly dryRun: boolean;
}

export interface UpsertResult {
	readonly url: string;
	readonly number: number | null;
	readonly action: 'created' | 'updated' | 'unchanged' | 'dry-run';
}

interface Issue {
	readonly number: number;
	readonly html_url: string;
	readonly updated_at: string;
	readonly body: string | null;
	readonly pull_request?: object;
}

function selectMostRecentIssue(candidates: readonly Issue[]): {
	readonly target: Issue | undefined;
	readonly matchCount: number;
} {
	let target: Issue | undefined;
	let matchCount = 0;

	for (const candidate of candidates) {
		if (candidate.pull_request) continue;
		matchCount++;
		if (!target || candidate.updated_at > target.updated_at) target = candidate;
	}

	return { target, matchCount };
}

// The labels identify the report issue because its title may be edited by a
// maintainer. Only the issue body is managed; existing comments are untouched.
export async function upsertIssue(octokit: Octokit, params: UpsertParams): Promise<UpsertResult> {
	if (params.dryRun) {
		core.info(`[dry-run] would file issue in ${params.owner}/${params.repo}`);
		core.info(`[dry-run] title: ${params.title}`);
		core.info(`[dry-run] labels: ${params.labels.join(', ')}`);
		core.info(`[dry-run] body:\n${params.body}`);
		return { url: '', number: null, action: 'dry-run' };
	}

	const candidates = (await octokit.paginate('GET /repos/{owner}/{repo}/issues', {
		owner: params.owner,
		repo: params.repo,
		state: 'open',
		labels: params.labels.join(','),
		per_page: 100,
	})) as Issue[];
	const { target, matchCount } = selectMostRecentIssue(candidates);

	if (!target) {
		const { data } = await octokit.request('POST /repos/{owner}/{repo}/issues', {
			owner: params.owner,
			repo: params.repo,
			title: params.title,
			body: params.body,
			labels: [...params.labels],
		});
		core.info(`opened issue #${data.number} in ${params.owner}/${params.repo}`);
		return { url: data.html_url, number: data.number, action: 'created' };
	}

	if (matchCount > 1) {
		core.warning(
			`found ${matchCount} open audit issues in ${params.owner}/${params.repo}; updating the most recent`,
		);
	}

	if (target.body === params.body) {
		core.info(`unchanged issue #${target.number} in ${params.owner}/${params.repo}`);
		return { url: target.html_url, number: target.number, action: 'unchanged' };
	}

	await octokit.request('PATCH /repos/{owner}/{repo}/issues/{issue_number}', {
		owner: params.owner,
		repo: params.repo,
		issue_number: target.number,
		body: params.body,
	});

	core.info(`updated issue #${target.number} in ${params.owner}/${params.repo}`);
	return { url: target.html_url, number: target.number, action: 'updated' };
}
