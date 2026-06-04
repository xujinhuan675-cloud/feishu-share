import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Buffer } from 'node:buffer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function loadSyncStateService() {
	const result = await build({
		entryPoints: [path.join(rootDir, 'src', 'sync-state.ts')],
		bundle: true,
		format: 'esm',
		platform: 'node',
		write: false
	});
	const source = result.outputFiles[0].text;
	const url = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
	return import(url);
}

const { SyncStateService } = await loadSyncStateService();

function createSettings(overrides = {}) {
	return {
		uploadHistory: [],
		syncStates: [],
		...overrides
	};
}

test('synced updates advance both local and remote baselines', () => {
	const settings = createSettings();
	const service = new SyncStateService(settings);
	const state = service.upsert({
		filePath: 'Notes/alpha.md',
		title: 'alpha',
		content: 'hello',
		bitableRecordId: 'rec1',
		direction: 'bitable',
		status: 'synced',
		remoteHash: 'hash-1',
		remoteUpdatedAt: 100
	});

	assert.equal(settings.syncStates.length, 1);
	assert.equal(state.localHash, service.hashContent('hello'));
	assert.equal(state.remoteHash, 'hash-1');
	assert.equal(state.remoteUpdatedAt, 100);
	assert.equal(state.observedRemoteHash, 'hash-1');
	assert.equal(state.observedRemoteUpdatedAt, 100);
	assert.equal(typeof state.remoteObservedAt, 'number');
});

test('conflicts preserve baselines and store the latest remote observation', () => {
	const settings = createSettings();
	const service = new SyncStateService(settings);
	service.upsert({
		filePath: 'Notes/alpha.md',
		content: 'baseline',
		direction: 'bitable',
		status: 'synced',
		remoteHash: 'hash-1',
		remoteUpdatedAt: 100
	});

	const state = service.upsert({
		filePath: 'Notes/alpha.md',
		content: 'local draft',
		direction: 'bitable',
		status: 'conflict',
		error: 'both sides changed',
		remoteHash: 'hash-2',
		remoteUpdatedAt: 200
	});

	assert.equal(state.status, 'conflict');
	assert.equal(state.localHash, service.hashContent('baseline'));
	assert.equal(state.remoteHash, 'hash-1');
	assert.equal(state.remoteUpdatedAt, 100);
	assert.equal(state.observedRemoteHash, 'hash-2');
	assert.equal(state.observedRemoteUpdatedAt, 200);
	assert.equal(state.lastError, 'both sides changed');
});

test('remote hash changes are detected without local changes', () => {
	const settings = createSettings();
	const service = new SyncStateService(settings);
	service.upsert({
		filePath: 'Notes/alpha.md',
		content: 'same local content',
		direction: 'bitable',
		status: 'synced',
		remoteHash: 'hash-1',
		remoteUpdatedAt: 100
	});

	const evaluation = service.evaluateSync('Notes/alpha.md', 'same local content', {
		hash: 'hash-2',
		updatedAt: 100
	});

	assert.equal(evaluation.hasBaseline, true);
	assert.equal(evaluation.hasLocalChanges, false);
	assert.equal(evaluation.hasRemoteBaseline, true);
	assert.equal(evaluation.hasRemoteChanges, true);
	assert.equal(evaluation.lastRemoteHash, 'hash-1');
	assert.equal(evaluation.remoteHash, 'hash-2');
});

test('observed remote snapshots merge per target instead of clearing other fields', () => {
	const settings = createSettings();
	const service = new SyncStateService(settings);
	service.upsert({
		filePath: 'Notes/alpha.md',
		content: 'baseline',
		direction: 'obsidian-to-feishu',
		status: 'synced',
		remoteRevision: 'rev-1',
		remoteUpdatedAt: 100
	});

	const state = service.upsert({
		filePath: 'Notes/alpha.md',
		direction: 'bitable',
		status: 'error',
		error: 'bitable failed',
		remoteHash: 'hash-2'
	});

	assert.equal(state.remoteRevision, 'rev-1');
	assert.equal(state.remoteHash, undefined);
	assert.equal(state.observedRemoteRevision, 'rev-1');
	assert.equal(state.observedRemoteHash, 'hash-2');
});

test('observed remote snapshots keep doc and Bitable observations independently', () => {
	const settings = createSettings();
	const service = new SyncStateService(settings);
	const docState = service.upsert({
		filePath: 'Notes/both.md',
		content: 'content',
		direction: 'obsidian-to-feishu',
		status: 'synced',
		remoteRevision: 'rev-1',
		remoteUpdatedAt: 100
	});
	const bitableState = service.upsert({
		filePath: 'Notes/both.md',
		direction: 'bitable',
		status: 'error',
		error: 'Bitable read failed',
		remoteHash: 'hash-2',
		remoteUpdatedAt: 200
	});

	assert.equal(docState.observedDocRemoteRevision, 'rev-1');
	assert.equal(docState.observedDocRemoteUpdatedAt, 100);
	assert.equal(typeof docState.docRemoteObservedAt, 'number');
	assert.equal(bitableState.observedDocRemoteRevision, 'rev-1');
	assert.equal(bitableState.observedDocRemoteUpdatedAt, 100);
	assert.equal(bitableState.observedBitableRemoteHash, 'hash-2');
	assert.equal(bitableState.observedBitableRemoteUpdatedAt, 200);
	assert.equal(bitableState.observedRemoteUpdatedAt, 200);
	assert.equal(typeof bitableState.bitableRemoteObservedAt, 'number');
});

test('compound remote snapshots advance and observe doc and Bitable baselines together', () => {
	const settings = createSettings();
	const service = new SyncStateService(settings);
	const state = service.upsert({
		filePath: 'Notes/both.md',
		content: 'content',
		direction: 'bitable',
		status: 'synced',
		docRemoteRevision: 'rev-2',
		docRemoteUpdatedAt: 100,
		bitableRemoteHash: 'hash-2',
		bitableRemoteUpdatedAt: 200
	});

	assert.equal(state.remoteRevision, 'rev-2');
	assert.equal(state.remoteHash, 'hash-2');
	assert.equal(state.remoteUpdatedAt, 200);
	assert.equal(state.docRemoteRevision, 'rev-2');
	assert.equal(state.docRemoteUpdatedAt, 100);
	assert.equal(state.bitableRemoteHash, 'hash-2');
	assert.equal(state.bitableRemoteUpdatedAt, 200);
	assert.equal(state.observedDocRemoteRevision, 'rev-2');
	assert.equal(state.observedDocRemoteUpdatedAt, 100);
	assert.equal(state.observedBitableRemoteHash, 'hash-2');
	assert.equal(state.observedBitableRemoteUpdatedAt, 200);
});

test('doc and Bitable remote baselines are tracked independently', () => {
	const settings = createSettings();
	const service = new SyncStateService(settings);
	service.upsert({
		filePath: 'Notes/both.md',
		content: 'content',
		direction: 'obsidian-to-feishu',
		status: 'synced',
		remoteRevision: 'rev-1',
		remoteUpdatedAt: 100
	});

	const state = service.upsert({
		filePath: 'Notes/both.md',
		content: 'content',
		direction: 'bitable',
		status: 'synced',
		remoteHash: 'hash-1',
		remoteUpdatedAt: 200
	});

	assert.equal(state.docRemoteRevision, 'rev-1');
	assert.equal(state.docRemoteUpdatedAt, 100);
	assert.equal(state.bitableRemoteHash, 'hash-1');
	assert.equal(state.bitableRemoteUpdatedAt, 200);
	assert.equal(state.remoteRevision, 'rev-1');
	assert.equal(state.remoteHash, 'hash-1');
});

test('Bitable evaluation prefers the Bitable-specific remote hash baseline', () => {
	const settings = createSettings({
		syncStates: [{
			filePath: 'Notes/both.md',
			localHash: 'ignored-for-this-test',
			remoteHash: 'old-generic-hash',
			bitableRemoteHash: 'current-bitable-hash'
		}]
	});
	const service = new SyncStateService(settings);
	const evaluation = service.evaluateSync('Notes/both.md', 'content', {
		hash: 'current-bitable-hash'
	});

	assert.equal(evaluation.hasRemoteBaseline, true);
	assert.equal(evaluation.hasRemoteChanges, false);
	assert.equal(evaluation.lastRemoteHash, 'current-bitable-hash');
});

test('remote updatedAt evaluation uses the requested target-specific baseline', () => {
	const settings = createSettings({
		syncStates: [
			{
				filePath: 'Notes/doc.md',
				localHash: 'ignored-for-this-test',
				remoteUpdatedAt: 999,
				docRemoteUpdatedAt: 100
			},
			{
				filePath: 'Notes/bitable.md',
				localHash: 'ignored-for-this-test',
				remoteUpdatedAt: 100,
				bitableRemoteUpdatedAt: 200
			}
		]
	});
	const service = new SyncStateService(settings);

	const docEvaluation = service.evaluateSync('Notes/doc.md', 'content', {
		kind: 'doc',
		updatedAt: 150
	});
	const bitableEvaluation = service.evaluateSync('Notes/bitable.md', 'content', {
		kind: 'bitable',
		updatedAt: 150
	});

	assert.equal(docEvaluation.remoteKind, 'doc');
	assert.equal(docEvaluation.lastRemoteUpdatedAt, 100);
	assert.equal(docEvaluation.hasRemoteChanges, true);
	assert.equal(bitableEvaluation.remoteKind, 'bitable');
	assert.equal(bitableEvaluation.lastRemoteUpdatedAt, 200);
	assert.equal(bitableEvaluation.hasRemoteChanges, false);
});

test('error snapshots can preserve split doc and Bitable observations without advancing baselines', () => {
	const settings = createSettings();
	const service = new SyncStateService(settings);
	service.upsert({
		filePath: 'Notes/both-error.md',
		content: 'baseline',
		direction: 'bitable',
		status: 'synced',
		docRemoteRevision: 'rev-1',
		docRemoteUpdatedAt: 100,
		bitableRemoteHash: 'hash-1',
		bitableRemoteUpdatedAt: 200
	});

	const state = service.upsert({
		filePath: 'Notes/both-error.md',
		content: 'draft',
		direction: 'bitable',
		status: 'error',
		error: 'partial sync failed',
		docRemoteRevision: 'rev-2',
		docRemoteUpdatedAt: 300,
		bitableRemoteHash: 'hash-2',
		bitableRemoteUpdatedAt: 400
	});

	assert.equal(state.status, 'error');
	assert.equal(state.localHash, service.hashContent('baseline'));
	assert.equal(state.docRemoteRevision, 'rev-1');
	assert.equal(state.docRemoteUpdatedAt, 100);
	assert.equal(state.bitableRemoteHash, 'hash-1');
	assert.equal(state.bitableRemoteUpdatedAt, 200);
	assert.equal(state.observedDocRemoteRevision, 'rev-2');
	assert.equal(state.observedDocRemoteUpdatedAt, 300);
	assert.equal(state.observedBitableRemoteHash, 'hash-2');
	assert.equal(state.observedBitableRemoteUpdatedAt, 400);
	assert.equal(state.lastError, 'partial sync failed');
});

test('upload history can be migrated into sync state entries', () => {
	const settings = createSettings({
		uploadHistory: [{
			filePath: 'Notes/history.md',
			title: 'history',
			docToken: 'doc-token',
			url: 'https://feishu.cn/docx/doc-token',
			bitableRecordId: 'rec-history',
			updatedAt: 123
		}]
	});
	const service = new SyncStateService(settings);

	service.migrateFromHistory();

	assert.equal(settings.syncStates.length, 1);
	assert.deepEqual(settings.syncStates[0], {
		filePath: 'Notes/history.md',
		title: 'history',
		docToken: 'doc-token',
		url: 'https://feishu.cn/docx/doc-token',
		bitableRecordId: 'rec-history',
		lastSyncedAt: 123,
		status: 'synced'
	});
});

test('sync states can be removed by local file path', () => {
	const settings = createSettings({
		syncStates: [
			{ filePath: 'Notes/remove.md', title: 'remove', status: 'error', localMissing: true },
			{ filePath: 'Notes/keep.md', title: 'keep', status: 'synced' }
		]
	});
	const service = new SyncStateService(settings);

	assert.equal(service.removeByFilePath('Notes/remove.md'), true);
	assert.deepEqual(settings.syncStates, [{ filePath: 'Notes/keep.md', title: 'keep', status: 'synced' }]);
	assert.equal(service.removeByFilePath('Notes/missing.md'), false);
	assert.equal(service.removeByFilePath(''), false);
});
