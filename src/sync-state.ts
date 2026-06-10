import type { FeishuSettings, SyncDirection, SyncStateItem, SyncStatus } from './types';

type SyncStateUpdate = {
	filePath: string;
	title?: string;
	content?: string;
	docToken?: string;
	url?: string;
	bitableRecordId?: string;
	bitableProfileId?: string;
	bitableAppToken?: string;
	bitableTableId?: string;
	bitableViewId?: string;
	direction: SyncDirection;
	status?: SyncStatus;
	error?: string;
	remoteHash?: string;
	remoteRevision?: string;
	remoteUpdatedAt?: number;
	docRemoteRevision?: string;
	docRemoteUpdatedAt?: number;
	bitableRemoteHash?: string;
	bitableRemoteUpdatedAt?: number;
};

type RemoteSnapshot = {
	remoteHash?: string;
	remoteRevision?: string;
	remoteUpdatedAt?: number;
	docRemoteRevision?: string;
	docRemoteUpdatedAt?: number;
	bitableRemoteHash?: string;
	bitableRemoteUpdatedAt?: number;
};

export type LocalChangeInfo = {
	hasBaseline: boolean;
	hasLocalChanges: boolean;
	currentHash: string;
	lastHash?: string;
	state: SyncStateItem | null;
};

export type RemoteChangeInput = {
	kind?: RemoteChangeKind;
	hash?: string;
	revision?: string;
	updatedAt?: number;
};

export type RemoteChangeKind = 'doc' | 'bitable';

export type SyncChangeEvaluation = LocalChangeInfo & {
	hasRemoteBaseline: boolean;
	hasRemoteChanges: boolean;
	remoteKind?: RemoteChangeKind;
	remoteHash?: string;
	lastRemoteHash?: string;
	remoteRevision?: string;
	lastRemoteRevision?: string;
	remoteUpdatedAt?: number;
	lastRemoteUpdatedAt?: number;
};

export function isRemoteUpdatedAfterLocal(remoteUpdatedAt?: number, localUpdatedAt?: number, skewToleranceMs: number = 1000): boolean {
	if (typeof remoteUpdatedAt !== 'number' || typeof localUpdatedAt !== 'number') {
		return false;
	}
	const tolerance = Number.isFinite(skewToleranceMs) ? Math.max(0, Math.floor(skewToleranceMs)) : 1000;
	return remoteUpdatedAt > (localUpdatedAt + tolerance);
}

export class SyncStateService {
	private settings: FeishuSettings;

	constructor(settings: FeishuSettings) {
		this.settings = settings;
	}

	updateSettings(settings: FeishuSettings): void {
		this.settings = settings;
	}

	migrateFromHistory(): void {
		const states = this.getStates();
		const history = Array.isArray(this.settings.uploadHistory) ? this.settings.uploadHistory : [];
		for (const item of history) {
			if (!item || !item.filePath) {
				continue;
			}
			if (states.some((state) => state && state.filePath === item.filePath)) {
				continue;
			}
			states.push({
				filePath: item.filePath,
				title: item.title,
				docToken: item.docToken,
				url: item.url,
				bitableRecordId: item.bitableRecordId,
				lastSyncedAt: item.updatedAt,
				status: 'synced'
			});
		}
		this.settings.syncStates = states;
	}

	hashContent(content: string): string {
		let hash = 2166136261;
		const text = String(content || '');
		for (let i = 0; i < text.length; i++) {
			hash ^= text.charCodeAt(i);
			hash = Math.imul(hash, 16777619);
		}
		return (hash >>> 0).toString(16).padStart(8, '0');
	}

	getState(filePath: string): SyncStateItem | null {
		const states = this.getStates();
		return states.find((item) => item && item.filePath === filePath) || null;
	}

	renamePath(oldPath: string, newPath: string, title?: string): boolean {
		const oldFilePath = String(oldPath || '').trim();
		const newFilePath = String(newPath || '').trim();
		if (!oldFilePath || !newFilePath || oldFilePath === newFilePath) {
			return false;
		}
		const states = this.getStates();
		const oldIdx = states.findIndex((item) => item && item.filePath === oldFilePath);
		if (oldIdx < 0) {
			return false;
		}
		const newIdx = states.findIndex((item, idx) => idx !== oldIdx && item && item.filePath === newFilePath);
		const moved: SyncStateItem = {
			...(states[oldIdx] || { filePath: newFilePath }),
			filePath: newFilePath,
			title: title || states[oldIdx]?.title,
			localMissing: false,
			status: states[oldIdx]?.status === 'error' && states[oldIdx]?.lastError === '本地文件已删除' ? 'synced' : states[oldIdx]?.status,
			lastError: states[oldIdx]?.lastError === '本地文件已删除' ? undefined : states[oldIdx]?.lastError
		};
		if (newIdx >= 0) {
			states[newIdx] = { ...states[newIdx], ...moved };
			states.splice(oldIdx, 1);
		} else {
			states[oldIdx] = moved;
		}
		this.settings.syncStates = states;
		return true;
	}

	markLocalMissing(filePath: string): boolean {
		const path = String(filePath || '').trim();
		if (!path) {
			return false;
		}
		const states = this.getStates();
		const idx = states.findIndex((item) => item && item.filePath === path);
		if (idx < 0) {
			return false;
		}
		states[idx] = {
			...states[idx],
			localMissing: true,
			status: 'error',
			lastError: '本地文件已删除',
			lastSyncedAt: Date.now()
		};
		this.settings.syncStates = states;
		return true;
	}

	markLocalPresent(filePath: string, title?: string): boolean {
		const path = String(filePath || '').trim();
		if (!path) {
			return false;
		}
		const states = this.getStates();
		const idx = states.findIndex((item) => item && item.filePath === path);
		if (idx < 0) {
			return false;
		}
		if (!states[idx].localMissing && states[idx].lastError !== '本地文件已删除') {
			return false;
		}
		states[idx] = {
			...states[idx],
			title: title || states[idx].title,
			localMissing: false,
			status: states[idx].lastError === '本地文件已删除' ? 'synced' : states[idx].status,
			lastError: states[idx].lastError === '本地文件已删除' ? undefined : states[idx].lastError,
			lastSyncedAt: Date.now()
		};
		this.settings.syncStates = states;
		return true;
	}

	removeByDocToken(docToken: string): boolean {
		const token = String(docToken || '').trim();
		if (!token) {
			return false;
		}
		const states = this.getStates();
		const next = states.filter((item) => !(item && item.docToken && String(item.docToken) === token));
		if (next.length === states.length) {
			return false;
		}
		this.settings.syncStates = next;
		return true;
	}

	removeByFilePath(filePath: string): boolean {
		const path = String(filePath || '').trim();
		if (!path) {
			return false;
		}
		const states = this.getStates();
		const next = states.filter((item) => !(item && item.filePath === path));
		if (next.length === states.length) {
			return false;
		}
		this.settings.syncStates = next;
		return true;
	}

	getLocalChange(filePath: string, content: string): LocalChangeInfo {
		return this.getLocalChangeForKind(filePath, content);
	}

	private getLocalChangeForKind(filePath: string, content: string, kind?: RemoteChangeKind | null): LocalChangeInfo {
		const state = this.getState(filePath);
		const currentHash = this.hashContent(content);
		const lastHash = this.getLastLocalHash(state, kind);
		return {
			hasBaseline: !!lastHash,
			hasLocalChanges: !!lastHash && lastHash !== currentHash,
			currentHash,
			lastHash,
			state
		};
	}

	evaluateSync(filePath: string, content: string, remote?: RemoteChangeInput | null): SyncChangeEvaluation {
		const remoteKind = this.inferRemoteKind(remote);
		const local = this.getLocalChangeForKind(filePath, content, remoteKind);
		const state = local.state;
		const remoteHash = remote?.hash;
		const remoteRevision = remote?.revision;
		const remoteUpdatedAt = remote?.updatedAt;
		const lastRemoteHash = remoteHash ? (state?.bitableRemoteHash || state?.remoteHash) : undefined;
		const lastRemoteRevision = remoteRevision ? (state?.docRemoteRevision || state?.remoteRevision) : undefined;
		const lastRemoteUpdatedAt = this.getLastRemoteUpdatedAt(state, remoteKind);
		const hasRemoteBaseline = !!lastRemoteRevision || !!lastRemoteHash || typeof lastRemoteUpdatedAt === 'number';
		const hasRemoteChanges = (() => {
			if (remoteRevision && lastRemoteRevision) {
				return remoteRevision !== lastRemoteRevision;
			}
			if (remoteHash && lastRemoteHash) {
				return remoteHash !== lastRemoteHash;
			}
			if (typeof remoteUpdatedAt === 'number' && typeof lastRemoteUpdatedAt === 'number') {
				return remoteUpdatedAt > lastRemoteUpdatedAt;
			}
			return false;
		})();

		return {
			...local,
			hasRemoteBaseline,
			hasRemoteChanges,
			remoteKind: remoteKind || undefined,
			remoteHash,
			lastRemoteHash,
			remoteRevision,
			lastRemoteRevision,
			remoteUpdatedAt,
			lastRemoteUpdatedAt
		};
	}

	upsert(update: SyncStateUpdate): SyncStateItem {
		const states = this.getStates();
		const idx = states.findIndex((item) => item && item.filePath === update.filePath);
		const existing = idx >= 0 ? states[idx] : this.stateFromHistory(update.filePath);
		const now = Date.now();
		const status = update.status || (update.error ? 'error' : 'synced');
		const shouldAdvanceBaseline = status === 'synced';
		const hasRemoteSnapshot = this.hasRemoteSnapshot(update);
		const isDocDirection = update.direction === 'obsidian-to-feishu' || update.direction === 'feishu-to-obsidian';
		const isBitableDirection = update.direction === 'bitable';
		const contentHash = shouldAdvanceBaseline && update.content !== undefined
			? this.hashContent(update.content)
			: undefined;
		const docRemoteRevision = update.docRemoteRevision || update.remoteRevision;
		const docRemoteUpdatedAt = typeof update.docRemoteUpdatedAt === 'number'
			? update.docRemoteUpdatedAt
			: (isDocDirection ? update.remoteUpdatedAt : undefined);
		const bitableRemoteHash = update.bitableRemoteHash || update.remoteHash;
		const bitableRemoteUpdatedAt = typeof update.bitableRemoteUpdatedAt === 'number'
			? update.bitableRemoteUpdatedAt
			: (isBitableDirection ? update.remoteUpdatedAt : undefined);
		const remoteUpdatedAt = this.maxTimestamp(update.remoteUpdatedAt, docRemoteUpdatedAt, bitableRemoteUpdatedAt, existing?.remoteUpdatedAt);
		const hasDocSnapshot = !!docRemoteRevision || typeof docRemoteUpdatedAt === 'number';
		const hasBitableSnapshot = !!bitableRemoteHash || typeof bitableRemoteUpdatedAt === 'number';
		const next: SyncStateItem = {
			...(existing || { filePath: update.filePath }),
			filePath: update.filePath,
			title: update.title || existing?.title,
			docToken: update.docToken || existing?.docToken,
			url: update.url || existing?.url,
			bitableRecordId: update.bitableRecordId || existing?.bitableRecordId,
			bitableProfileId: update.bitableProfileId || existing?.bitableProfileId,
			bitableAppToken: update.bitableAppToken || existing?.bitableAppToken,
			bitableTableId: update.bitableTableId || existing?.bitableTableId,
			bitableViewId: update.bitableViewId || existing?.bitableViewId,
			localHash: contentHash || existing?.localHash,
			docLocalHash: isDocDirection && contentHash ? contentHash : existing?.docLocalHash,
			bitableLocalHash: isBitableDirection && contentHash ? contentHash : existing?.bitableLocalHash,
			lastDirection: update.direction,
			status,
			lastSyncedAt: now,
			lastError: update.error || undefined,
			remoteHash: shouldAdvanceBaseline ? (bitableRemoteHash || existing?.remoteHash) : existing?.remoteHash,
			remoteRevision: shouldAdvanceBaseline ? (docRemoteRevision || existing?.remoteRevision) : existing?.remoteRevision,
			remoteUpdatedAt: shouldAdvanceBaseline ? remoteUpdatedAt : existing?.remoteUpdatedAt,
			docRemoteRevision: shouldAdvanceBaseline && hasDocSnapshot ? (docRemoteRevision || existing?.docRemoteRevision || existing?.remoteRevision) : existing?.docRemoteRevision,
			docRemoteUpdatedAt: shouldAdvanceBaseline && hasDocSnapshot ? (typeof docRemoteUpdatedAt === 'number' ? docRemoteUpdatedAt : existing?.docRemoteUpdatedAt) : existing?.docRemoteUpdatedAt,
			bitableRemoteHash: shouldAdvanceBaseline && hasBitableSnapshot ? (bitableRemoteHash || existing?.bitableRemoteHash || existing?.remoteHash) : existing?.bitableRemoteHash,
			bitableRemoteUpdatedAt: shouldAdvanceBaseline && hasBitableSnapshot ? (typeof bitableRemoteUpdatedAt === 'number' ? bitableRemoteUpdatedAt : existing?.bitableRemoteUpdatedAt) : existing?.bitableRemoteUpdatedAt,
			observedRemoteHash: hasRemoteSnapshot ? (bitableRemoteHash || existing?.observedRemoteHash) : existing?.observedRemoteHash,
			observedRemoteRevision: hasRemoteSnapshot ? (docRemoteRevision || existing?.observedRemoteRevision) : existing?.observedRemoteRevision,
			observedRemoteUpdatedAt: hasRemoteSnapshot ? this.maxTimestamp(update.remoteUpdatedAt, docRemoteUpdatedAt, bitableRemoteUpdatedAt, existing?.observedRemoteUpdatedAt) : existing?.observedRemoteUpdatedAt,
			remoteObservedAt: hasRemoteSnapshot ? now : existing?.remoteObservedAt,
			observedDocRemoteRevision: hasDocSnapshot ? (docRemoteRevision || existing?.observedDocRemoteRevision || existing?.observedRemoteRevision) : existing?.observedDocRemoteRevision,
			observedDocRemoteUpdatedAt: hasDocSnapshot ? (typeof docRemoteUpdatedAt === 'number' ? docRemoteUpdatedAt : existing?.observedDocRemoteUpdatedAt) : existing?.observedDocRemoteUpdatedAt,
			docRemoteObservedAt: hasDocSnapshot ? now : existing?.docRemoteObservedAt,
			observedBitableRemoteHash: hasBitableSnapshot ? (bitableRemoteHash || existing?.observedBitableRemoteHash || existing?.observedRemoteHash) : existing?.observedBitableRemoteHash,
			observedBitableRemoteUpdatedAt: hasBitableSnapshot ? (typeof bitableRemoteUpdatedAt === 'number' ? bitableRemoteUpdatedAt : existing?.observedBitableRemoteUpdatedAt) : existing?.observedBitableRemoteUpdatedAt,
			bitableRemoteObservedAt: hasBitableSnapshot ? now : existing?.bitableRemoteObservedAt
		};

		if (idx >= 0) {
			states[idx] = { ...states[idx], ...next };
		} else {
			states.unshift(next);
		}
		this.settings.syncStates = states;
		return next;
	}

	private hasRemoteSnapshot(remote: RemoteSnapshot): boolean {
		return !!remote.remoteHash
			|| !!remote.remoteRevision
			|| typeof remote.remoteUpdatedAt === 'number'
			|| !!remote.docRemoteRevision
			|| typeof remote.docRemoteUpdatedAt === 'number'
			|| !!remote.bitableRemoteHash
			|| typeof remote.bitableRemoteUpdatedAt === 'number';
	}

	private inferRemoteKind(remote?: RemoteChangeInput | null): RemoteChangeKind | null {
		if (!remote) {
			return null;
		}
		if (remote.kind) {
			return remote.kind;
		}
		if (remote.hash) {
			return 'bitable';
		}
		if (remote.revision) {
			return 'doc';
		}
		return null;
	}

	private getLastLocalHash(state: SyncStateItem | null, kind?: RemoteChangeKind | null): string | undefined {
		if (!state) {
			return undefined;
		}
		if (kind === 'doc') {
			return state.docLocalHash || state.localHash;
		}
		if (kind === 'bitable') {
			return state.bitableLocalHash || state.localHash;
		}
		return state.localHash;
	}

	private getLastRemoteUpdatedAt(state: SyncStateItem | null, remoteKind: RemoteChangeKind | null): number | undefined {
		if (remoteKind === 'bitable') {
			return state?.bitableRemoteUpdatedAt ?? state?.remoteUpdatedAt;
		}
		if (remoteKind === 'doc') {
			return state?.docRemoteUpdatedAt ?? state?.remoteUpdatedAt;
		}
		return state?.remoteUpdatedAt;
	}

	private maxTimestamp(...values: Array<number | undefined>): number | undefined {
		const timestamps = values.filter((value): value is number => typeof value === 'number');
		if (!timestamps.length) {
			return undefined;
		}
		return Math.max(...timestamps);
	}

	private getStates(): SyncStateItem[] {
		if (!Array.isArray(this.settings.syncStates)) {
			this.settings.syncStates = [];
		}
		return this.settings.syncStates;
	}

	private stateFromHistory(filePath: string): SyncStateItem | null {
		const history = Array.isArray(this.settings.uploadHistory) ? this.settings.uploadHistory : [];
		const hit = history.find((item) => item && item.filePath === filePath);
		if (!hit) {
			return null;
		}
		return {
			filePath,
			title: hit.title,
			docToken: hit.docToken,
			url: hit.url,
			bitableRecordId: hit.bitableRecordId,
			bitableProfileId: hit.bitableProfileId,
			bitableAppToken: hit.bitableAppToken,
			bitableTableId: hit.bitableTableId,
			bitableViewId: hit.bitableViewId,
			lastSyncedAt: hit.updatedAt
		};
	}
}
