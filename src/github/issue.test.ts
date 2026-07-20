import { describe, it, expect, vi } from 'vitest';
import { upsertIssue } from './issue.js';
import type { Octokit } from '../types.js';

vi.mock('@actions/core', () => ({
	info: vi.fn(),
	warning: vi.fn(),
	debug: vi.fn(),
	error: vi.fn(),
}));

const makeOctokit = (opts: {
	issues?: unknown[];
	createResult?: { number: number; html_url: string };
}) => ({
	paginate: vi.fn(async (route: string) => {
		if (route === 'GET /repos/{owner}/{repo}/issues') return opts.issues ?? [];
		throw new Error(`Unexpected paginate route: ${route}`);
	}),
	request: vi.fn(async (route: string) => {
		if (route === 'POST /repos/{owner}/{repo}/issues') {
			return {
				data: opts.createResult ?? { number: 99, html_url: 'https://x/issues/99' },
			};
		}
		return { data: {} };
	}),
});

const baseParams = {
	owner: 'acme',
	repo: 'audits',
	title: 'Organization Inactivity Audit - acme',
	body: 'body',
	labels: ['organization-auditor', 'audit:org'] as const,
	dryRun: false,
};

describe('upsertIssue', () => {
	it('creates a new issue when none exists', async () => {
		const oct = makeOctokit({ issues: [] });
		const res = await upsertIssue(oct as unknown as Octokit, baseParams);
		expect(res.action).toBe('created');
		expect(res.url).toBe('https://x/issues/99');
		expect(oct.request).toHaveBeenCalledWith(
			'POST /repos/{owner}/{repo}/issues',
			expect.objectContaining({ title: baseParams.title, body: 'body' }),
		);
	});

	it('updates the most recent existing issue body', async () => {
		const oct = makeOctokit({
			issues: [
				{
					number: 6,
					html_url: 'https://x/issues/6',
					updated_at: '2026-04-20T00:00:00Z',
					body: 'old',
				},
				{
					number: 7,
					html_url: 'https://x/issues/7',
					updated_at: '2026-04-25T00:00:00Z',
					body: 'old',
				},
			],
		});
		const res = await upsertIssue(oct as unknown as Octokit, baseParams);
		expect(res.action).toBe('updated');
		expect(res.number).toBe(7);
		expect(oct.request).toHaveBeenCalledWith(
			'PATCH /repos/{owner}/{repo}/issues/{issue_number}',
			expect.objectContaining({ issue_number: 7, body: 'body' }),
		);
		expect(oct.request).toHaveBeenCalledTimes(1);
		expect(oct.paginate).toHaveBeenCalledTimes(1);
	});

	it('ignores pull requests returned by the issues endpoint', async () => {
		const oct = makeOctokit({
			issues: [
				{
					number: 7,
					html_url: 'https://x/pull/7',
					updated_at: '2026-04-25T00:00:00Z',
					body: 'old',
					pull_request: {},
				},
			],
		});

		const res = await upsertIssue(oct as unknown as Octokit, baseParams);

		expect(res.action).toBe('created');
		expect(res.number).toBe(99);
	});

	it('avoids writes when the issue body is unchanged', async () => {
		const oct = makeOctokit({
			issues: [
				{
					number: 7,
					html_url: 'https://x/issues/7',
					updated_at: '2026-04-25T00:00:00Z',
					body: 'body',
				},
			],
		});

		const res = await upsertIssue(oct as unknown as Octokit, baseParams);

		expect(res.action).toBe('unchanged');
		expect(oct.request).not.toHaveBeenCalled();
	});

	it('skips API calls in dry-run', async () => {
		const oct = makeOctokit({});
		const res = await upsertIssue(oct as unknown as Octokit, { ...baseParams, dryRun: true });
		expect(res.action).toBe('dry-run');
		expect(res.url).toBe('');
		expect(oct.paginate).not.toHaveBeenCalled();
		expect(oct.request).not.toHaveBeenCalled();
	});
});
