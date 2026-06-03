import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Buffer } from 'node:buffer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function loadDiagnostics() {
	const result = await build({
		entryPoints: [path.join(rootDir, 'src', 'sync-diagnostics.ts')],
		bundle: true,
		format: 'esm',
		platform: 'node',
		write: false
	});
	const source = result.outputFiles[0].text;
	const url = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
	return import(url);
}

const diagnostics = await loadDiagnostics();

const sampleStates = [
	{
		filePath: 'Notes/synced.md',
		title: 'Synced',
		status: 'synced',
		lastDirection: 'obsidian-to-feishu',
		lastSyncedAt: 10,
		localHash: 'local-1',
		remoteRevision: 'rev-1'
	},
	{
		filePath: 'Notes/conflict.md',
		title: 'Conflict',
		status: 'conflict',
		lastDirection: 'bitable',
		lastSyncedAt: 30,
		remoteHash: 'hash-base',
		observedRemoteHash: 'hash-observed',
		remoteObservedAt: 30,
		lastError: 'both changed'
	},
	{
		filePath: 'Notes/error.md',
		docToken: 'doc-error',
		status: 'error',
		lastDirection: 'feishu-to-obsidian',
		lastSyncedAt: 20
	},
	{
		filePath: 'Notes/drift.md',
		title: 'Drift',
		status: 'synced',
		lastSyncedAt: 40,
		remoteHash: 'baseline',
		observedRemoteHash: 'latest'
	}
];

test('counts include attention recommendations in problem sync states', () => {
	assert.deepEqual(diagnostics.getSyncStatusCounts(sampleStates), {
		all: 4,
		problem: 3,
		synced: 2,
		conflict: 1,
		error: 1
	});
});

test('problem filter includes conflicts, errors, and remote drift', () => {
	assert.deepEqual(
		diagnostics.filterSyncStates(sampleStates, 'problem').map((state) => state.filePath),
		['Notes/conflict.md', 'Notes/error.md', 'Notes/drift.md']
	);
});

test('sync state search matches visible status diagnostics and mapping fields', () => {
	const states = [
		{
			filePath: 'Projects/Alpha.md',
			title: 'Alpha Plan',
			status: 'synced',
			url: 'https://feishu.cn/docx/doc-alpha',
			bitableRecordId: 'rec-alpha',
			remoteHash: 'baseline',
			observedRemoteHash: 'latest'
		},
		{
			filePath: 'Projects/Beta.md',
			title: 'Beta Spec',
			status: 'error',
			lastError: 'network timeout while syncing'
		},
		{
			filePath: 'Archive/Gamma.md',
			title: 'Gamma Notes',
			status: 'synced'
		}
	];

	assert.deepEqual(diagnostics.searchSyncStates(states, '').map((state) => state.filePath), states.map((state) => state.filePath));
	assert.deepEqual(diagnostics.searchSyncStates(states, 'alpha plan').map((state) => state.filePath), ['Projects/Alpha.md']);
	assert.deepEqual(diagnostics.searchSyncStates(states, 'rec-alpha').map((state) => state.filePath), ['Projects/Alpha.md']);
	assert.deepEqual(diagnostics.searchSyncStates(states, '远端内容可能有新改动').map((state) => state.filePath), ['Projects/Alpha.md']);
	assert.deepEqual(diagnostics.searchSyncStates(states, 'network timeout').map((state) => state.filePath), ['Projects/Beta.md']);
	assert.deepEqual(diagnostics.searchSyncStates(states, '状态正常').map((state) => state.filePath), ['Archive/Gamma.md']);
});

test('sync states are sorted by newest activity with title fallback within the same priority', () => {
	const states = [
		{ filePath: 'z.md', title: 'Zed' },
		{ filePath: 'a.md', title: 'Alpha' },
		{ filePath: 'newer.md', title: 'Newer', lastSyncedAt: 100 }
	];

	assert.deepEqual(
		diagnostics.sortSyncStates(states).map((state) => state.title),
		['Newer', 'Alpha', 'Zed']
	);
});

test('sync states sort actionable records before newer healthy records', () => {
	const states = [
		{ filePath: 'healthy-new.md', title: 'Healthy New', status: 'synced', lastSyncedAt: 400 },
		{ filePath: 'attention-old.md', title: 'Attention Old', status: 'synced', lastSyncedAt: 100, remoteHash: 'base', observedRemoteHash: 'latest' },
		{ filePath: 'error.md', title: 'Error', status: 'error', lastSyncedAt: 50 },
		{ filePath: 'conflict.md', title: 'Conflict', status: 'conflict', lastSyncedAt: 10 }
	];

	assert.deepEqual(
		diagnostics.sortSyncStates(states).map((state) => state.title),
		['Conflict', 'Error', 'Attention Old', 'Healthy New']
	);
});

test('status view builds a readable title, URL, status, and detail text', () => {
	const view = diagnostics.buildSyncStatusView(sampleStates[1], (timestamp) => `T${timestamp}`);

	assert.equal(view.title, 'Conflict');
	assert.equal(view.status, 'conflict');
	assert.equal(view.url, '');
	assert.equal(view.summary, '本地和远端都发生变化，需要选择保留哪一侧');
	assert.equal(view.canSync, true);
	assert.equal(view.detailText, '方向: 多维表格 · 远端哈希: hash-base · 观测哈希: hash-observed · 观测于: T30 · 错误: both changed');
	assert.deepEqual(view.detailParts.map((part) => part.label), ['方向', '远端哈希', '观测哈希', '观测于', '错误']);
	assert.deepEqual(view.detailParts.map((part) => part.group), ['summary', 'baseline', 'observed', 'observed', 'error']);
});

test('doc tokens create a default Feishu document URL', () => {
	const view = diagnostics.buildSyncStatusView(sampleStates[2], (timestamp) => `T${timestamp}`);

	assert.equal(view.title, 'Notes/error.md');
	assert.equal(view.url, 'https://feishu.cn/docx/doc-error');
	assert.equal(diagnostics.formatSyncStatus(view.status), '错误');
});

test('local missing states explain the mapping problem and cannot be synced in bulk', () => {
	const view = diagnostics.buildSyncStatusView({
		filePath: 'Notes/missing.md',
		status: 'error',
		localMissing: true,
		lastError: '本地文件已删除'
	});

	assert.equal(view.canSync, false);
	assert.equal(view.shouldAutoSync, false);
	assert.equal(view.summary, '本地文件已删除，需恢复文件或清理映射');
	assert.deepEqual(view.recommendation, {
		level: 'blocked',
		label: '本地文件缺失',
		action: '恢复本地文件后再同步，或清理这条本地映射'
	});
});

test('synced states can still surface observed remote drift', () => {
	const view = diagnostics.buildSyncStatusView({
		filePath: 'Notes/drift.md',
		status: 'synced',
		remoteHash: 'baseline',
		observedRemoteHash: 'latest'
	});

	assert.equal(view.summary, '最近检测到远端内容与同步基线不同');
});

test('synced states prefer target-specific drift summaries over generic baselines', () => {
	const bitableView = diagnostics.buildSyncStatusView({
		filePath: 'Notes/bitable-drift.md',
		status: 'synced',
		remoteHash: 'latest',
		bitableRemoteHash: 'baseline',
		observedRemoteHash: 'latest',
		observedBitableRemoteHash: 'latest'
	});
	const docView = diagnostics.buildSyncStatusView({
		filePath: 'Notes/doc-drift.md',
		status: 'synced',
		remoteRevision: 'latest',
		docRemoteRevision: 'baseline',
		observedRemoteRevision: 'latest',
		observedDocRemoteRevision: 'latest'
	});

	assert.equal(bitableView.summary, '最近检测到多维表格内容与同步基线不同');
	assert.equal(docView.summary, '最近检测到飞书文档 revision 与同步基线不同');
	assert.deepEqual(bitableView.recommendation, {
		level: 'attention',
		label: '多维表格可能有新改动',
		action: '运行智能同步；需要保留远端时从多维表格更新本地'
	});
	assert.deepEqual(docView.recommendation, {
		level: 'attention',
		label: '飞书文档可能有新改动',
		action: '运行智能同步；需要保留远端时从飞书更新本地'
	});
});

test('status recommendations explain conflict, error, drift, and healthy records', () => {
	const conflictView = diagnostics.buildSyncStatusView({
		filePath: 'Notes/conflict.md',
		status: 'conflict'
	});
	const errorView = diagnostics.buildSyncStatusView({
		filePath: 'Notes/error.md',
		status: 'error',
		lastError: 'network failed'
	});
	const genericDriftView = diagnostics.buildSyncStatusView({
		filePath: 'Notes/drift.md',
		status: 'synced',
		remoteHash: 'baseline',
		observedRemoteHash: 'latest'
	});
	const healthyView = diagnostics.buildSyncStatusView({
		filePath: 'Notes/healthy.md',
		status: 'synced'
	});

	assert.deepEqual(conflictView.recommendation, {
		level: 'blocked',
		label: '需要人工决策',
		action: '先运行智能同步，再选择拉取远端或推送本地'
	});
	assert.deepEqual(errorView.recommendation, {
		level: 'attention',
		label: '上次同步失败',
		action: '查看错误信息后重试智能同步'
	});
	assert.deepEqual(genericDriftView.recommendation, {
		level: 'attention',
		label: '远端内容可能有新改动',
		action: '运行智能同步确认本地与远端差异'
	});
	assert.deepEqual(healthyView.recommendation, {
		level: 'healthy',
		label: '状态正常',
		action: '暂无需处理；本地改动后可继续使用智能同步'
	});
});

test('status view separates manual sync availability from batch auto-sync eligibility', () => {
	const healthyView = diagnostics.buildSyncStatusView({
		filePath: 'Notes/healthy.md',
		status: 'synced'
	});
	const driftView = diagnostics.buildSyncStatusView({
		filePath: 'Notes/drift.md',
		status: 'synced',
		remoteHash: 'baseline',
		observedRemoteHash: 'latest'
	});
	const conflictView = diagnostics.buildSyncStatusView({
		filePath: 'Notes/conflict.md',
		status: 'conflict'
	});
	const errorView = diagnostics.buildSyncStatusView({
		filePath: 'Notes/error.md',
		status: 'error'
	});
	const missingView = diagnostics.buildSyncStatusView({
		filePath: 'Notes/missing.md',
		status: 'error',
		localMissing: true
	});

	assert.equal(healthyView.canSync, true);
	assert.equal(healthyView.shouldAutoSync, false);
	assert.equal(driftView.canSync, true);
	assert.equal(driftView.shouldAutoSync, true);
	assert.equal(conflictView.canSync, true);
	assert.equal(conflictView.shouldAutoSync, true);
	assert.equal(errorView.canSync, true);
	assert.equal(errorView.shouldAutoSync, true);
	assert.equal(missingView.canSync, false);
	assert.equal(missingView.shouldAutoSync, false);
});

test('batch sync summaries describe empty, successful, and partially failed runs', () => {
	assert.equal(
		diagnostics.formatSyncBatchSummary({ total: 0, succeeded: 0, failed: 0 }),
		'当前筛选下没有需要智能同步的本地文件'
	);
	assert.equal(
		diagnostics.formatSyncBatchSummary({ total: 3, succeeded: 3, failed: 0 }),
		'✅ 需关注项已同步完成：成功 3/3'
	);
	assert.equal(
		diagnostics.formatSyncBatchSummary({
			total: 4,
			succeeded: 2,
			failed: 2,
			failedTitles: ['A.md', 'B.md']
		}),
		'⚠️ 需关注项同步完成：成功 2/4，失败 2；失败：A.md、B.md'
	);
	assert.equal(
		diagnostics.formatSyncBatchSummary({
			total: 6,
			succeeded: 2,
			failed: 4,
			failedTitles: ['A.md', 'B.md', 'C.md', 'D.md']
		}),
		'⚠️ 需关注项同步完成：成功 2/6，失败 4；失败：A.md、B.md、C.md 等 4 个'
	);
});

test('status details include split observed doc and Bitable snapshots', () => {
	const view = diagnostics.buildSyncStatusView({
		filePath: 'Notes/observed-both.md',
		status: 'synced',
		observedDocRemoteRevision: 'rev-2',
		observedDocRemoteUpdatedAt: 100,
		docRemoteObservedAt: 110,
		observedBitableRemoteHash: 'hash-2',
		observedBitableRemoteUpdatedAt: 200,
		bitableRemoteObservedAt: 210
	}, (timestamp) => `T${timestamp}`);

	assert.deepEqual(
		view.detailParts.map((part) => `${part.label}=${part.value}`),
		[
			'方向=未知',
			'观测文档 revision=rev-2',
			'观测文档时间=T100',
			'观测文档于=T110',
			'观测 Bitable 哈希=hash-2',
			'观测 Bitable 时间=T200',
			'观测 Bitable 于=T210'
		]
	);
});

test('status details include split doc and Bitable baselines', () => {
	const view = diagnostics.buildSyncStatusView({
		filePath: 'Notes/both.md',
		status: 'synced',
		docRemoteRevision: 'rev-1',
		docRemoteUpdatedAt: 100,
		bitableRemoteHash: 'hash-1',
		bitableRemoteUpdatedAt: 200
	}, (timestamp) => `T${timestamp}`);

	assert.deepEqual(
		view.detailParts.map((part) => `${part.label}=${part.value}`),
		['方向=未知', '文档 revision=rev-1', '文档时间=T100', 'Bitable 哈希=hash-1', 'Bitable 时间=T200']
	);
});
