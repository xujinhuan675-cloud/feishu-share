import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Buffer } from 'node:buffer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function loadModule(entry) {
	const result = await build({
		entryPoints: [path.join(rootDir, 'src', entry)],
		bundle: true,
		format: 'esm',
		platform: 'node',
		write: false
	});
	const source = result.outputFiles[0].text;
	const url = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
	return import(url);
}

const profileModule = await loadModule('bitable-profile.ts');
const syncStateModule = await loadModule('sync-state.ts');

const {
	DEFAULT_ANCHOROS_TASK_PROFILE,
	applyProfileRecordToMarkdown,
	buildProfileBitableFieldsFromMarkdown,
	buildProfileManagedContent,
	buildProfileRemoteManagedContent,
	extractFrontMatterObject,
	extractProfileControlledBlock,
	getProfileRecordIdFromMarkdown,
	normalizeBitableProfile,
	renderProfileFileName,
	resolveProfileFieldName,
	selectBitableProfileForFile,
	selectScheduledBitableProfiles
} = profileModule;
const { SyncStateService } = syncStateModule;

const profile = {
	...DEFAULT_ANCHOROS_TASK_PROFILE,
	fieldMapping: {
		title: '标题',
		status: '状态',
		body: '正文',
		owner: '负责人',
		priority: '优先级',
		category: '分类'
	},
	reverseStatusMapping: {
		active: '进行中'
	}
};

test('profile maps Feishu fields into frontmatter and a controlled block', () => {
	const content = '---\nlocal_only: keep\n---\n\nUser note stays here.\n';
	const next = applyProfileRecordToMarkdown(content, profile, 'recA', {
		'标题': 'Build sync',
		'状态': '进行中',
		'正文': 'Remote task brief',
		'负责人': { name: 'Alice' },
		'优先级': 'P1',
		'分类': 'dev'
	}, Date.parse('2026-06-05T00:00:00.000Z'));

	const fm = extractFrontMatterObject(next);
	assert.equal(fm.local_only, 'keep');
	assert.equal(fm.feishu_record_id, 'recA');
	assert.equal(fm.feishu_table_id, profile.tableId);
	assert.equal(fm.feishu_view_id, profile.viewId);
	assert.equal(fm.status, 'active');
	assert.equal(fm.feishu_status, '进行中');
	assert.equal(fm.owner, 'Alice');
	assert.equal(fm.feishu_priority, 'P1');
	assert.equal(fm.feishu_category, 'dev');
	assert.equal(extractProfileControlledBlock(next, profile), 'Remote task brief');
	assert.match(next, /User note stays here\./);
});

test('profile writes mapped frontmatter and controlled block back to Feishu fields', () => {
	const content = [
		'---',
		'status: active',
		'owner: "Bob"',
		'feishu_priority: "P2"',
		'feishu_category: "ops"',
		'---',
		'<!-- feishu-share:bitable-profile:anchoros-task-profile:begin -->',
		'Local controlled body',
		'<!-- feishu-share:bitable-profile:anchoros-task-profile:end -->',
		'',
		'Private local note'
	].join('\n');
	const fieldMeta = new Map([
		['状态', { name: '状态', type: 3 }],
		['负责人', { name: '负责人', type: 1 }],
		['正文', { name: '正文', type: 1 }],
		['优先级', { name: '优先级', type: 3 }],
		['分类', { name: '分类', type: 3 }]
	]);

	const fields = buildProfileBitableFieldsFromMarkdown(content, profile, fieldMeta, Date.now());

	assert.deepEqual(fields, {
		'状态': '进行中',
		'负责人': 'Bob',
		'优先级': 'P2',
		'分类': 'ops',
		'正文': 'Local controlled body'
	});
});

test('record identity prefers feishu_record_id and profile selection can use target dir or frontmatter', () => {
	assert.equal(getProfileRecordIdFromMarkdown('---\nfeishu_record_id: recA\nrecordId: old\n---\n'), 'recA');
	assert.equal(getProfileRecordIdFromMarkdown('---\nrecordId: recLegacy\n---\n'), 'recLegacy');

	assert.equal(
		selectBitableProfileForFile([profile], '3-工作台/1-任务池/飞书任务/Build sync.md')?.id,
		'anchoros-task-profile'
	);
	assert.equal(
		selectBitableProfileForFile([profile], 'Other/Build sync.md', '---\nfeishu_profile: anchoros-task-profile\n---\n')?.id,
		'anchoros-task-profile'
	);
});

test('conflict detection uses only profile-managed markdown content', () => {
	const settings = { syncStates: [] };
	const service = new SyncStateService(settings);
	const baseline = applyProfileRecordToMarkdown('User note v1\n', profile, 'recA', {
		'状态': '进行中',
		'正文': 'Remote body'
	}, 1);
	const baselineManaged = buildProfileManagedContent(baseline, profile);
	const baselineRemote = service.hashContent(buildProfileRemoteManagedContent(profile, 'recA', {
		'状态': '进行中',
		'正文': 'Remote body'
	}));
	service.upsert({
		filePath: '3-工作台/1-任务池/飞书任务/Build sync.md',
		content: baselineManaged,
		direction: 'bitable',
		remoteHash: baselineRemote
	});

	const outsideOnly = `${baseline}\nUser note v2\n`;
	assert.equal(
		service.evaluateSync('3-工作台/1-任务池/飞书任务/Build sync.md', buildProfileManagedContent(outsideOnly, profile), {
			kind: 'bitable',
			hash: baselineRemote
		}).hasLocalChanges,
		false
	);

	const localManagedChanged = baseline.replace('Remote body', 'Local controlled body');
	const remoteChangedHash = service.hashContent(buildProfileRemoteManagedContent(profile, 'recA', {
		'状态': '进行中',
		'正文': 'Remote body changed'
	}));
	const evaluation = service.evaluateSync('3-工作台/1-任务池/飞书任务/Build sync.md', buildProfileManagedContent(localManagedChanged, profile), {
		kind: 'bitable',
		hash: remoteChangedHash
	});
	assert.equal(evaluation.hasLocalChanges, true);
	assert.equal(evaluation.hasRemoteChanges, true);
});

test('scheduled profile selection respects enabled profiles and per-profile schedules', () => {
	const scheduledProfile = { ...profile, scheduledSyncEnabled: true };
	const other = {
		...profile,
		id: 'other',
		name: 'Other',
		targetDir: 'Other',
		enabled: false,
		scheduledSyncEnabled: true
	};
	assert.deepEqual(
		selectScheduledBitableProfiles([scheduledProfile, other], ['anchoros-task-profile']).map((item) => item.id),
		['anchoros-task-profile']
	);
	assert.deepEqual(
		selectScheduledBitableProfiles([scheduledProfile, { ...other, enabled: true }], []).map((item) => item.id),
		['anchoros-task-profile', 'other']
	);
	assert.deepEqual(
		selectScheduledBitableProfiles([{ ...scheduledProfile, scheduledSyncEnabled: false }, { ...other, enabled: true }], []).map((item) => item.id),
		['other']
	);
});

test('persisted default profile keeps title mapping and fuzzy-matches emoji field names', () => {
	const persisted = normalizeBitableProfile({
		...DEFAULT_ANCHOROS_TASK_PROFILE,
		fieldMapping: {
			status: '状态'
		}
	});
	assert.ok(persisted);
	assert.equal(
		resolveProfileFieldName(persisted, 'title', new Set(['🟦任务描述', '状态'])),
		'🟦任务描述'
	);
	assert.equal(
		renderProfileFileName(persisted, 'recTitle', {
			'🟦任务描述': 'ai社媒创建'
		}),
		'ai社媒创建'
	);
});

test('profile falls back to a readable body when no dedicated body field is mapped', () => {
	const persisted = normalizeBitableProfile({
		...DEFAULT_ANCHOROS_TASK_PROFILE,
		fieldNamesCache: ['🟦任务描述', '🟩需求梳理', '完成时间', '开始时间', '状态'],
		fieldMapping: {
			status: '状态'
		}
	});
	assert.ok(persisted);
	const fieldMeta = new Map([
		['完成时间', { name: '完成时间', type: 5 }],
		['开始时间', { name: '开始时间', type: 5 }]
	]);
	const next = applyProfileRecordToMarkdown('', persisted, 'recBody', {
		'开始时间': 1773653856636,
		'🟦任务描述': 'ai社媒创建',
		'🟩需求梳理': '社媒内容分发工具',
		'完成时间': 1774355400000,
		'状态': '进行中'
	}, Date.now(), fieldMeta);
	assert.equal(renderProfileFileName(persisted, 'recBody', {
		'🟦任务描述': 'ai社媒创建'
	}), 'ai社媒创建');
	const body = extractProfileControlledBlock(next, persisted);
	assert.match(body, /## 需求梳理\n社媒内容分发工具/);
	assert.match(body, /## 完成时间\n20\d{2}\/\d{2}\/\d{2} \d{2}:\d{2}/);
	assert.match(body, /## 开始时间\n20\d{2}\/\d{2}\/\d{2} \d{2}:\d{2}/);
	assert.doesNotMatch(body, /1774355400000|1773653856636/);
	assert.doesNotMatch(body, /## 任务描述/);
	assert.ok(body.indexOf('## 需求梳理') < body.indexOf('## 完成时间'));
	assert.ok(body.indexOf('## 完成时间') < body.indexOf('## 开始时间'));
});
