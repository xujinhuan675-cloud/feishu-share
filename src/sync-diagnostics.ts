import type { SyncDirection, SyncStateItem, SyncStatus } from './types';

export type SyncStatusFilter = 'all' | 'problem' | SyncStatus;

export type SyncStatusCounts = Record<SyncStatusFilter, number>;

export type SyncStatusDetailGroup = 'summary' | 'baseline' | 'observed' | 'mapping' | 'error';

export type SyncStatusDetail = {
	label: string;
	value: string;
	group: SyncStatusDetailGroup;
};

export type SyncStatusRecommendationLevel = 'healthy' | 'attention' | 'blocked';

export type SyncStatusRecommendation = {
	level: SyncStatusRecommendationLevel;
	label: string;
	action: string;
};

export type SyncBatchSummary = {
	total: number;
	succeeded: number;
	failed: number;
	failedTitles?: string[];
};

export type SyncStatusView = {
	state: SyncStateItem;
	status: SyncStatus;
	title: string;
	url: string;
	lastSyncedAt?: number;
	summary: string;
	recommendation: SyncStatusRecommendation;
	canSync: boolean;
	shouldAutoSync: boolean;
	detailParts: SyncStatusDetail[];
	detailText: string;
};

export type DateFormatter = (timestamp: number) => string;

const defaultDateFormatter: DateFormatter = (timestamp) => new Date(timestamp).toLocaleString();

export function normalizeSyncStatus(status?: string): SyncStatus {
	if (status === 'conflict' || status === 'error') {
		return status;
	}
	return 'synced';
}

export function getSyncStatusCounts(states: SyncStateItem[]): SyncStatusCounts {
	const counts: SyncStatusCounts = {
		all: states.length,
		problem: 0,
		synced: 0,
		conflict: 0,
		error: 0
	};
	states.forEach((state) => {
		const status = normalizeSyncStatus(state.status);
		counts[status] += 1;
		if (isProblemState(state, status)) {
			counts.problem += 1;
		}
	});
	return counts;
}

export function filterSyncStates(states: SyncStateItem[], filter: SyncStatusFilter): SyncStateItem[] {
	if (filter === 'all') {
		return states;
	}
	return states.filter((state) => {
		const status = normalizeSyncStatus(state.status);
		if (filter === 'problem') {
			return isProblemState(state, status);
		}
		return status === filter;
	});
}

export function searchSyncStates(states: SyncStateItem[], query: string): SyncStateItem[] {
	const q = String(query || '').trim().toLowerCase();
	if (!q) {
		return states;
	}
	return states.filter((state) => buildSyncSearchText(state).includes(q));
}

export function sortSyncStates(states: SyncStateItem[]): SyncStateItem[] {
	return [...states].sort((a, b) => {
		const byPriority = getSortPriority(b) - getSortPriority(a);
		if (byPriority !== 0) {
			return byPriority;
		}
		const byTime = (b.lastSyncedAt || 0) - (a.lastSyncedAt || 0);
		if (byTime !== 0) {
			return byTime;
		}
		return getSyncStatusTitle(a).localeCompare(getSyncStatusTitle(b));
	});
}

export function buildSyncStatusView(state: SyncStateItem, formatDate: DateFormatter = defaultDateFormatter): SyncStatusView {
	const status = normalizeSyncStatus(state.status);
	const detailParts = buildSyncStatusDetails(state, formatDate);
	const recommendation = getSyncStatusRecommendation(state, status);
	const canSync = !!state.filePath && !state.localMissing;
	return {
		state,
		status,
		title: getSyncStatusTitle(state),
		url: getSyncStatusUrl(state),
		lastSyncedAt: state.lastSyncedAt,
		summary: getSyncStatusSummary(state, status),
		recommendation,
		canSync,
		shouldAutoSync: canSync && recommendation.level !== 'healthy',
		detailParts,
		detailText: detailParts.map((part) => `${part.label}: ${part.value}`).join(' · ')
	};
}

export function formatSyncBatchSummary(summary: SyncBatchSummary): string {
	const total = Math.max(0, summary.total || 0);
	const succeeded = Math.max(0, summary.succeeded || 0);
	const failed = Math.max(0, summary.failed || 0);
	if (total === 0) {
		return '当前筛选下没有需要智能同步的本地文件';
	}
	if (failed === 0) {
		return `✅ 需关注项已同步完成：成功 ${succeeded}/${total}`;
	}
	const failedTitles = (summary.failedTitles || []).filter(Boolean);
	const preview = failedTitles.slice(0, 3).join('、');
	const suffix = preview
		? `；失败：${preview}${failedTitles.length > 3 ? ` 等 ${failedTitles.length} 个` : ''}`
		: '';
	return `⚠️ 需关注项同步完成：成功 ${succeeded}/${total}，失败 ${failed}${suffix}`;
}

export function buildSyncStatusDetails(state: SyncStateItem, formatDate: DateFormatter = defaultDateFormatter): SyncStatusDetail[] {
	const details: SyncStatusDetail[] = [];
	addDetail(details, '方向', formatSyncDirection(state.lastDirection || ''), 'summary');
	addDetail(details, '本地哈希', state.localHash, 'baseline');
	addDetail(details, '远端哈希', state.remoteHash, 'baseline');
	addDetail(details, '远端 revision', state.remoteRevision, 'baseline');
	addDetail(details, '远端时间', formatOptionalDate(state.remoteUpdatedAt, formatDate), 'baseline');
	addDetail(details, '文档 revision', state.docRemoteRevision, 'baseline');
	addDetail(details, '文档时间', formatOptionalDate(state.docRemoteUpdatedAt, formatDate), 'baseline');
	addDetail(details, 'Bitable 哈希', state.bitableRemoteHash, 'baseline');
	addDetail(details, 'Bitable 时间', formatOptionalDate(state.bitableRemoteUpdatedAt, formatDate), 'baseline');
	addDetail(details, '观测哈希', state.observedRemoteHash, 'observed');
	addDetail(details, '观测 revision', state.observedRemoteRevision, 'observed');
	addDetail(details, '观测远端时间', formatOptionalDate(state.observedRemoteUpdatedAt, formatDate), 'observed');
	addDetail(details, '观测于', formatOptionalDate(state.remoteObservedAt, formatDate), 'observed');
	addDetail(details, '观测文档 revision', state.observedDocRemoteRevision, 'observed');
	addDetail(details, '观测文档时间', formatOptionalDate(state.observedDocRemoteUpdatedAt, formatDate), 'observed');
	addDetail(details, '观测文档于', formatOptionalDate(state.docRemoteObservedAt, formatDate), 'observed');
	addDetail(details, '观测 Bitable 哈希', state.observedBitableRemoteHash, 'observed');
	addDetail(details, '观测 Bitable 时间', formatOptionalDate(state.observedBitableRemoteUpdatedAt, formatDate), 'observed');
	addDetail(details, '观测 Bitable 于', formatOptionalDate(state.bitableRemoteObservedAt, formatDate), 'observed');
	addDetail(details, 'Bitable', state.bitableRecordId, 'mapping');
	addDetail(details, '错误', state.lastError, 'error');
	return details;
}

export function getSyncStatusTitle(state: SyncStateItem): string {
	return state.title || state.filePath || state.docToken || '未命名文档';
}

export function getSyncStatusUrl(state: SyncStateItem): string {
	return state.url || (state.docToken ? `https://feishu.cn/docx/${state.docToken}` : '');
}

export function formatSyncStatus(status: SyncStatus): string {
	if (status === 'conflict') return '冲突';
	if (status === 'error') return '错误';
	return '已同步';
}

export function formatSyncDirection(direction: SyncDirection | string): string {
	if (direction === 'obsidian-to-feishu') return 'Obsidian -> 飞书';
	if (direction === 'feishu-to-obsidian') return '飞书 -> Obsidian';
	if (direction === 'bitable') return '多维表格';
	return '未知';
}

export function getSyncStatusSummary(state: SyncStateItem, status: SyncStatus = normalizeSyncStatus(state.status)): string {
	if (state.localMissing) {
		return '本地文件已删除，需恢复文件或清理映射';
	}
	if (status === 'conflict') {
		return '本地和远端都发生变化，需要选择保留哪一侧';
	}
	if (status === 'error') {
		return state.lastError || '上次同步失败，建议查看错误后重试';
	}
	const observedBitableHash = state.observedBitableRemoteHash || state.observedRemoteHash;
	const observedDocRevision = state.observedDocRemoteRevision || state.observedRemoteRevision;
	if (observedBitableHash && state.bitableRemoteHash && observedBitableHash !== state.bitableRemoteHash) {
		return '最近检测到多维表格内容与同步基线不同';
	}
	if (observedDocRevision && state.docRemoteRevision && observedDocRevision !== state.docRemoteRevision) {
		return '最近检测到飞书文档 revision 与同步基线不同';
	}
	if (state.observedRemoteHash && state.remoteHash && state.observedRemoteHash !== state.remoteHash) {
		return '最近检测到远端内容与同步基线不同';
	}
	if (state.observedRemoteRevision && state.remoteRevision && state.observedRemoteRevision !== state.remoteRevision) {
		return '最近检测到飞书文档 revision 与同步基线不同';
	}
	return '本地与已记录的远端基线一致';
}

export function getSyncStatusRecommendation(state: SyncStateItem, status: SyncStatus = normalizeSyncStatus(state.status)): SyncStatusRecommendation {
	if (state.localMissing) {
		return {
			level: 'blocked',
			label: '本地文件缺失',
			action: '恢复本地文件后再同步，或清理这条本地映射'
		};
	}
	if (status === 'conflict') {
		return {
			level: 'blocked',
			label: '需要人工决策',
			action: '先运行智能同步，再选择拉取远端或推送本地'
		};
	}
	if (status === 'error') {
		return {
			level: 'attention',
			label: '上次同步失败',
			action: state.lastError ? '查看错误信息后重试智能同步' : '重试智能同步，若失败再检查授权和映射'
		};
	}
	const observedBitableHash = state.observedBitableRemoteHash || state.observedRemoteHash;
	const observedDocRevision = state.observedDocRemoteRevision || state.observedRemoteRevision;
	if (observedBitableHash && state.bitableRemoteHash && observedBitableHash !== state.bitableRemoteHash) {
		return {
			level: 'attention',
			label: '多维表格可能有新改动',
			action: '运行智能同步；需要保留远端时从多维表格更新本地'
		};
	}
	if (observedDocRevision && state.docRemoteRevision && observedDocRevision !== state.docRemoteRevision) {
		return {
			level: 'attention',
			label: '飞书文档可能有新改动',
			action: '运行智能同步；需要保留远端时从飞书更新本地'
		};
	}
	if (state.observedRemoteHash && state.remoteHash && state.observedRemoteHash !== state.remoteHash) {
		return {
			level: 'attention',
			label: '远端内容可能有新改动',
			action: '运行智能同步确认本地与远端差异'
		};
	}
	if (state.observedRemoteRevision && state.remoteRevision && state.observedRemoteRevision !== state.remoteRevision) {
		return {
			level: 'attention',
			label: '飞书文档可能有新改动',
			action: '运行智能同步；需要保留远端时从飞书更新本地'
		};
	}
	return {
		level: 'healthy',
		label: '状态正常',
		action: '暂无需处理；本地改动后可继续使用智能同步'
	};
}

function isProblemStatus(status: SyncStatus): boolean {
	return status === 'conflict' || status === 'error';
}

function isProblemState(state: SyncStateItem, status: SyncStatus = normalizeSyncStatus(state.status)): boolean {
	return isProblemStatus(status) || getSyncStatusRecommendation(state, status).level !== 'healthy';
}

function getSortPriority(state: SyncStateItem): number {
	const status = normalizeSyncStatus(state.status);
	if (status === 'conflict' || state.localMissing) {
		return 3;
	}
	if (status === 'error') {
		return 2;
	}
	const recommendation = getSyncStatusRecommendation(state, status);
	if (recommendation.level === 'blocked') {
		return 3;
	}
	if (recommendation.level === 'attention') {
		return 1;
	}
	return 0;
}

function buildSyncSearchText(state: SyncStateItem): string {
	const view = buildSyncStatusView(state);
	return [
		view.title,
		view.url,
		view.status,
		formatSyncStatus(view.status),
		view.summary,
		view.recommendation.label,
		view.recommendation.action,
		view.detailText,
		state.filePath,
		state.docToken,
		state.bitableRecordId,
		state.lastError
	]
		.filter((part) => part !== undefined && part !== null)
		.map((part) => String(part).toLowerCase())
		.join('\n');
}

function addDetail(details: SyncStatusDetail[], label: string, value: string | undefined, group: SyncStatusDetailGroup): void {
	if (!value) {
		return;
	}
	details.push({ label, value, group });
}

function formatOptionalDate(timestamp: number | undefined, formatDate: DateFormatter): string | undefined {
	return typeof timestamp === 'number' ? formatDate(timestamp) : undefined;
}
