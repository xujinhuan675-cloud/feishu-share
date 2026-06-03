import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Buffer } from 'node:buffer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function loadPlanModule() {
	const result = await build({
		entryPoints: [path.join(rootDir, 'src', 'smart-sync-plan.ts')],
		bundle: true,
		format: 'esm',
		platform: 'node',
		write: false
	});
	const source = result.outputFiles[0].text;
	const url = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
	return import(url);
}

const { planSmartSyncBoth } = await loadPlanModule();

const synced = {
	mapped: true,
	hasBaseline: true,
	hasLocalChanges: false,
	hasRemoteChanges: false
};

test('both sync creates all mappings when nothing is mapped', () => {
	assert.equal(
		planSmartSyncBoth({ ...synced, mapped: false, hasBaseline: false }, { ...synced, mapped: false, hasBaseline: false }).action,
		'create-all'
	);
});

test('both sync pushes local changes only when remotes are unchanged', () => {
	const plan = planSmartSyncBoth({ ...synced, hasLocalChanges: true }, { ...synced, hasLocalChanges: true });
	assert.equal(plan.action, 'push-all');
	assert.equal(plan.convergeAfterPull, false);
});

test('both sync pulls the changed Bitable record before pushing local content', () => {
	const plan = planSmartSyncBoth(synced, { ...synced, hasRemoteChanges: true });
	assert.equal(plan.action, 'pull-bitable');
	assert.equal(plan.convergeAfterPull, true);
});

test('both sync asks before overwriting Bitable when local content also changed', () => {
	const plan = planSmartSyncBoth({ ...synced, hasLocalChanges: true }, { ...synced, hasLocalChanges: true, hasRemoteChanges: true });
	assert.equal(plan.action, 'choose-local-vs-bitable');
	assert.equal(plan.convergeAfterPull, true);
});

test('both sync asks for a remote source when both remotes changed', () => {
	const plan = planSmartSyncBoth({ ...synced, hasRemoteChanges: true }, { ...synced, hasRemoteChanges: true });
	assert.equal(plan.action, 'choose-remote-source');
	assert.equal(plan.convergeAfterPull, true);
});

test('both sync backfills a missing Bitable mapping by pushing all', () => {
	assert.equal(
		planSmartSyncBoth(synced, { ...synced, mapped: false }).action,
		'push-all'
	);
});

test('both sync is a noop when all baselines and remotes are current', () => {
	const plan = planSmartSyncBoth(synced, synced);
	assert.equal(plan.action, 'noop');
	assert.equal(plan.convergeAfterPull, false);
});
