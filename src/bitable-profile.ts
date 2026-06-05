import type { BitableFieldMeta, BitableSyncProfile, BitableTableOption } from './types';
import { bitableFieldToDisplayText, bitableFieldToFrontMatterValue, bitableFieldToPlainText, normalizeBitableWriteValue } from './bitable-fields';

export const IOTO_TASK_PROFILE_ID = 'ioto-task';

export const PROFILE_FRONTMATTER_FIELDS = [
	'stage',
	'status',
	'ai_scope',
	'owner',
	'project',
	'source',
	'related',
	'next_action',
	'review_required',
	'feishu_record_id',
	'feishu_table_id',
	'feishu_view_id',
	'feishu_status',
	'feishu_priority',
	'feishu_category',
	'feishu_synced_at'
];

const WRITEBACK_FRONTMATTER_FIELDS = [
	'stage',
	'status',
	'ai_scope',
	'owner',
	'project',
	'source',
	'related',
	'next_action',
	'review_required',
	'feishu_priority',
	'feishu_category'
];

export const DEFAULT_IOTO_TASK_PROFILE: BitableSyncProfile = {
	id: IOTO_TASK_PROFILE_ID,
	name: 'IOTO Task Profile',
	enabled: true,
	appToken: 'Wl3rbgORca63instiTpcaz1DnvZ',
	tableId: 'tbl02ZXD0Kkb2xOB',
	viewId: 'vewx3UsjHG',
	targetDir: 'IOTO/Tasks',
	fileNameTemplate: '{{title}}',
	fieldMapping: {
		title: ['任务', '任务描述', 'Title', 'title', '名称'],
		body: ['正文', '说明', 'Description', 'description', 'content'],
		stage: ['阶段', 'Stage', 'stage'],
		status: ['状态', 'Status', 'status'],
		ai_scope: ['AI Scope', 'AI范围', 'AI 范围', 'ai_scope'],
		owner: ['负责人', 'Owner', 'owner'],
		project: ['项目', 'Project', 'project'],
		source: ['来源', 'Source', 'source'],
		related: ['关联', 'Related', 'related'],
		next_action: ['下一步', 'Next Action', 'next_action'],
		review_required: ['需复核', 'Review Required', 'review_required'],
		priority: ['优先级', 'Priority', 'priority'],
		category: ['分类', 'Category', 'category']
	},
	statusMapping: {
		'未开始': 'todo',
		'待处理': 'todo',
		'进行中': 'doing',
		'处理中': 'doing',
		'已完成': 'done',
		'完成': 'done',
		'已取消': 'cancelled',
		todo: 'todo',
		doing: 'doing',
		done: 'done',
		cancelled: 'cancelled'
	},
	reverseStatusMapping: {
		todo: '未开始',
		doing: '进行中',
		done: '已完成',
		cancelled: '已取消'
	},
	bodyFields: ['body'],
	primaryBodyField: 'body',
	bodyTemplate: '{{body}}',
	syncUncontrolledBody: false,
	fieldNamesCache: [],
	tableOptionsCache: [],
	scheduledSyncEnabled: false,
	scheduledSyncIntervalMinutes: 30,
	scheduledSyncRunOnStartup: false
};

function getEmbeddedProfileDefaults(profileId: string): BitableSyncProfile | null {
	return profileId === IOTO_TASK_PROFILE_ID ? DEFAULT_IOTO_TASK_PROFILE : null;
}

export type ProfileRemoteRecord = {
	recordId: string;
	fields: Record<string, any>;
	updatedAt?: number;
};

export function mergeDefaultBitableProfiles(profiles: BitableSyncProfile[] | undefined | null): BitableSyncProfile[] {
	const normalized = Array.isArray(profiles)
		? profiles
			.map(normalizeBitableProfile)
			.filter((profile): profile is BitableSyncProfile => !!profile)
		: [];
	return normalized.length > 0 ? normalized : [{ ...DEFAULT_IOTO_TASK_PROFILE }];
}

export function normalizeBitableProfile(profile: any): BitableSyncProfile | null {
	if (!profile || typeof profile !== 'object') {
		return null;
	}
	const id = String(profile.id || '').trim();
	const appToken = String(profile.appToken || '').trim();
	const tableId = String(profile.tableId || '').trim();
	if (!id || !appToken || !tableId) {
		return null;
	}
	const defaults = getEmbeddedProfileDefaults(id);
	const fieldMapping = {
		...normalizeProfileFieldMapping(defaults?.fieldMapping),
		...normalizeProfileFieldMapping(profile.fieldMapping)
	};
	const statusMapping = {
		...normalizeStringRecord(defaults?.statusMapping),
		...normalizeStringRecord(profile.statusMapping)
	};
	const reverseStatusMapping = {
		...normalizeStringRecord(defaults?.reverseStatusMapping),
		...normalizeStringRecord(profile.reverseStatusMapping)
	};
	const frontmatterFields = normalizeStringList(profile.frontmatterFields);
	const bodyFields = normalizeStringList(profile.bodyFields);
	return {
		...(defaults ? { ...defaults } : {}),
		...profile,
		id,
		name: String(profile.name || defaults?.name || id).trim(),
		enabled: profile.enabled !== false,
		appToken,
		tableId,
		viewId: String(profile.viewId || defaults?.viewId || '').trim(),
		targetDir: normalizeVaultPath(profile.targetDir || defaults?.targetDir || ''),
		fileNameTemplate: String(profile.fileNameTemplate || defaults?.fileNameTemplate || '{{title}}'),
		fieldMapping,
		statusMapping,
		reverseStatusMapping,
		frontmatterFields: frontmatterFields.length ? frontmatterFields : normalizeStringList(defaults?.frontmatterFields),
		bodyFields: bodyFields.length ? bodyFields : normalizeStringList(defaults?.bodyFields),
		primaryBodyField: String(profile.primaryBodyField || defaults?.primaryBodyField || '').trim(),
		bodyTemplate: String(profile.bodyTemplate || defaults?.bodyTemplate || '{{body}}'),
		syncUncontrolledBody: profile.syncUncontrolledBody !== undefined
			? !!profile.syncUncontrolledBody
			: !!defaults?.syncUncontrolledBody,
		fieldNamesCache: normalizeStringList(profile.fieldNamesCache),
		tableOptionsCache: Array.isArray(profile.tableOptionsCache)
			? profile.tableOptionsCache
				.map((item: any) => ({
					tableId: String(item?.tableId || '').trim(),
					name: String(item?.name || '').trim(),
					revision: typeof item?.revision === 'number' ? item.revision : undefined
				}))
				.filter((item: BitableTableOption) => !!item.tableId)
			: [],
		scheduledSyncEnabled: !!profile.scheduledSyncEnabled,
		scheduledSyncIntervalMinutes: Number.isFinite(Number(profile.scheduledSyncIntervalMinutes))
			? Math.max(5, Math.min(24 * 60, Math.round(Number(profile.scheduledSyncIntervalMinutes))))
			: 30,
		scheduledSyncRunOnStartup: !!profile.scheduledSyncRunOnStartup
	};
}

export function selectScheduledBitableProfiles(
	profiles: BitableSyncProfile[] | undefined | null,
	selectedIds?: string[] | null
): BitableSyncProfile[] {
	const all = mergeDefaultBitableProfiles(profiles).filter((profile) => profile.enabled !== false && profile.scheduledSyncEnabled);
	const selected = new Set((selectedIds || []).map((id) => String(id || '').trim()).filter((id) => !!id));
	if (!selected.size) {
		return all;
	}
	return all.filter((profile) => selected.has(profile.id));
}

export function selectBitableProfileForFile(
	profiles: BitableSyncProfile[] | undefined | null,
	filePath: string,
	content?: string,
	explicitProfileId?: string
): BitableSyncProfile | null {
	const all = mergeDefaultBitableProfiles(profiles).filter((profile) => profile.enabled !== false);
	const explicit = String(explicitProfileId || '').trim();
	if (explicit) {
		const hit = all.find((profile) => profile.id === explicit);
		if (hit) {
			return hit;
		}
	}
	const contentProfileId = content ? getProfileIdFromMarkdown(content) : '';
	if (contentProfileId) {
		const hit = all.find((profile) => profile.id === contentProfileId);
		if (hit) {
			return hit;
		}
	}
	return all.find((profile) => isPathInsideProfileTarget(filePath, profile)) || null;
}

export function getProfileIdFromMarkdown(content: string): string {
	const fm = extractFrontMatterObject(content);
	return String(fm.feishu_profile || fm.bitable_profile || '').trim();
}

export function isPathInsideProfileTarget(filePath: string, profile: BitableSyncProfile): boolean {
	const targetDir = normalizeVaultPath(profile.targetDir || '');
	if (!targetDir) {
		return false;
	}
	const path = normalizeVaultPath(filePath || '');
	return path === targetDir || path.startsWith(`${targetDir}/`);
}

export function getProfileFieldCandidates(profile: BitableSyncProfile, logicalKey: string): string[] {
	const key = String(logicalKey || '').trim();
	if (!key) {
		return [];
	}
	const mapping = profile.fieldMapping || {};
	const raw = mapping[key];
	const candidates = Array.isArray(raw)
		? raw
		: (raw ? [raw] : []);
	const withFallback = [...candidates, key]
		.map((item) => String(item || '').trim())
		.filter((item) => !!item);
	return [...new Set(withFallback)];
}

export function resolveProfileFieldName(
	profile: BitableSyncProfile,
	logicalKey: string,
	availableFieldNames?: Set<string>
): string {
	const candidates = getProfileFieldCandidates(profile, logicalKey);
	if (!candidates.length) {
		return '';
	}
	if (!availableFieldNames || !availableFieldNames.size) {
		return candidates[0];
	}
	return resolveFieldNameFromAvailable(availableFieldNames, candidates) || '';
}

export function getProfileFieldValue(fields: Record<string, any>, profile: BitableSyncProfile, logicalKey: string): any {
	if (!fields) {
		return undefined;
	}
	const fieldName = resolveFieldNameFromFields(fields, getProfileFieldCandidates(profile, logicalKey));
	return fieldName ? fields[fieldName] : undefined;
}

export function buildProfileFrontMatterFromRecord(
	profile: BitableSyncProfile,
	recordId: string,
	fields: Record<string, any>,
	now: number = Date.now()
): Record<string, any> {
	const frontmatterFields = getProfileFrontMatterFields(profile);
	const rawStatus = bitableFieldToPlainText(getProfileFieldValue(fields, profile, 'status')).trim();
	const result: Record<string, any> = {
		feishu_profile: profile.id
	};
	for (const key of frontmatterFields) {
		if (key === 'feishu_record_id') {
			result[key] = recordId;
			continue;
		}
		if (key === 'feishu_table_id') {
			result[key] = profile.tableId;
			continue;
		}
		if (key === 'feishu_view_id') {
			if (profile.viewId) {
				result[key] = profile.viewId;
			}
			continue;
		}
		if (key === 'feishu_status') {
			if (rawStatus) {
				result[key] = rawStatus;
			}
			continue;
		}
		if (key === 'feishu_priority') {
			const value = profileFieldToFrontMatterValue(getProfileFieldValue(fields, profile, 'priority'), key);
			if (value !== undefined) {
				result[key] = value;
			}
			continue;
		}
		if (key === 'feishu_category') {
			const value = profileFieldToFrontMatterValue(getProfileFieldValue(fields, profile, 'category'), key);
			if (value !== undefined) {
				result[key] = value;
			}
			continue;
		}
		if (key === 'feishu_synced_at') {
			result[key] = new Date(now).toISOString();
			continue;
		}
		if (key === 'status') {
			if (rawStatus) {
				result[key] = mapRemoteStatus(profile, rawStatus);
			}
			continue;
		}
		const value = profileFieldToFrontMatterValue(getProfileFieldValue(fields, profile, key), key);
		if (value !== undefined) {
			result[key] = value;
		}
	}
	return result;
}

export function applyProfileRecordToMarkdown(
	content: string,
	profile: BitableSyncProfile,
	recordId: string,
	fields: Record<string, any>,
	now: number = Date.now(),
	fieldMetaByName?: Map<string, BitableFieldMeta>
): string {
	let next = upsertFrontMatterFields(content, buildProfileFrontMatterFromRecord(profile, recordId, fields, now));
	if (getProfileBodyFields(profile).length > 0) {
		next = upsertProfileControlledBlock(next, profile, renderProfileBodyFromFields(profile, fields, fieldMetaByName));
	}
	return normalizeTrailingNewline(next);
}

export function buildProfileMarkdownFromRecord(
	profile: BitableSyncProfile,
	recordId: string,
	fields: Record<string, any>,
	now: number = Date.now(),
	fieldMetaByName?: Map<string, BitableFieldMeta>
): string {
	return applyProfileRecordToMarkdown('', profile, recordId, fields, now, fieldMetaByName);
}

export function buildProfileBitableFieldsFromMarkdown(
	content: string,
	profile: BitableSyncProfile,
	fieldMetaByName?: Map<string, BitableFieldMeta>,
	now: number = Date.now()
): Record<string, any> {
	const frontmatter = extractFrontMatterObject(content);
	const available = fieldMetaByName ? new Set(fieldMetaByName.keys()) : undefined;
	const fields: Record<string, any> = {};

	const setField = (logicalKey: string, value: any) => {
		if (value === undefined || value === null || value === '') {
			return;
		}
		const fieldName = resolveProfileFieldName(profile, logicalKey, available);
		if (!fieldName) {
			return;
		}
		fields[fieldName] = normalizeBitableWriteValue(value, fieldMetaByName?.get(fieldName), now);
	};

	for (const key of WRITEBACK_FRONTMATTER_FIELDS) {
		if (!Object.prototype.hasOwnProperty.call(frontmatter, key)) {
			continue;
		}
		const rawValue = frontmatter[key];
		if (key === 'status') {
			setField('status', mapLocalStatusToRemote(profile, rawValue));
		} else if (key === 'feishu_priority') {
			setField('priority', rawValue);
		} else if (key === 'feishu_category') {
			setField('category', rawValue);
		} else {
			setField(key, rawValue);
		}
	}

	if (!Object.prototype.hasOwnProperty.call(frontmatter, 'status') && frontmatter.feishu_status) {
		setField('status', frontmatter.feishu_status);
	}

	const body = extractProfileControlledBlock(content, profile);
	const primaryBodyField = getPrimaryBodyField(profile);
	if (body !== null) {
		setField(primaryBodyField, body);
	} else if (profile.syncUncontrolledBody) {
		const localBody = stripFrontMatter(content).trim();
		if (localBody) {
			setField(primaryBodyField, localBody);
		}
	}

	return fields;
}

export function getProfileRecordIdFromMarkdown(content: string): string {
	const frontmatter = extractFrontMatterObject(content);
	return String(frontmatter.feishu_record_id || frontmatter.recordId || frontmatter.bitableRecordId || '').trim();
}

export function buildProfileManagedContent(content: string, profile: BitableSyncProfile): string {
	const frontmatter = extractFrontMatterObject(content);
	const picked: Record<string, any> = {};
	const managedKeys = ['feishu_profile', ...getProfileFrontMatterFields(profile)];
	for (const key of managedKeys) {
		if (Object.prototype.hasOwnProperty.call(frontmatter, key)) {
			picked[key] = frontmatter[key];
		}
	}
	picked.controlled_block = extractProfileControlledBlock(content, profile) || '';
	return stableStringifyProfile(picked);
}

export function buildProfileRemoteManagedContent(
	profile: BitableSyncProfile,
	recordId: string,
	fields: Record<string, any>
): string {
	const remote: Record<string, any> = {
		profile_id: profile.id,
		record_id: recordId,
		table_id: profile.tableId,
		view_id: profile.viewId || ''
	};
	for (const key of [...getProfileFrontMatterFields(profile), ...getProfileBodyFields(profile), 'title', 'priority', 'category']) {
		if (key === 'feishu_synced_at') {
			continue;
		}
		if (key === 'title') {
			const title = resolveProfileTitleText(profile, recordId, fields);
			if (title) {
				remote.title = title;
			}
			continue;
		}
		const logicalKey = key === 'feishu_priority'
			? 'priority'
			: (key === 'feishu_category' ? 'category' : key);
		const value = getProfileFieldValue(fields, profile, logicalKey);
		if (value !== undefined) {
			remote[logicalKey] = value;
		}
	}
	return stableStringifyProfile(remote);
}

export function renderProfileBodyFromFields(
	profile: BitableSyncProfile,
	fields: Record<string, any>,
	fieldMetaByName?: Map<string, BitableFieldMeta>
): string {
	const values: Record<string, string> = {};
	values.title = resolveProfileTitleText(profile, '', fields);
	for (const key of [...getProfileBodyFields(profile), ...getProfileFrontMatterFields(profile), 'title', 'priority', 'category']) {
		const value = getProfileFieldValue(fields, profile, key);
		if (value !== undefined) {
			values[key] = bitableFieldToPlainText(value);
		}
	}
	const rendered = renderTemplate(profile.bodyTemplate || '{{body}}', values).trim();
	return rendered || buildFallbackProfileBody(profile, fields, fieldMetaByName);
}

export function extractProfileControlledBlock(content: string, profile: BitableSyncProfile): string | null {
	const normalized = normalizeLineEndings(content);
	const start = escapeRegExp(getProfileBlockStart(profile));
	const end = escapeRegExp(getProfileBlockEnd(profile));
	const match = normalized.match(new RegExp(`${start}\\n?([\\s\\S]*?)\\n?${end}`));
	if (!match) {
		return null;
	}
	return match[1].replace(/^\n+|\n+$/g, '');
}

export function upsertProfileControlledBlock(content: string, profile: BitableSyncProfile, body: string): string {
	const hadCrLf = /\r\n/.test(content);
	const normalized = normalizeLineEndings(content);
	const start = getProfileBlockStart(profile);
	const end = getProfileBlockEnd(profile);
	const block = `${start}\n${String(body || '').trim()}\n${end}`;
	const blockRe = new RegExp(`${escapeRegExp(start)}\\n?[\\s\\S]*?\\n?${escapeRegExp(end)}`);
	if (blockRe.test(normalized)) {
		return restoreLineEndings(normalized.replace(blockRe, block), hadCrLf);
	}
	const insert = `${block}\n\n`;
	const fm = getFrontMatterRange(normalized);
	if (fm) {
		const next = `${normalized.slice(0, fm.end)}\n${insert}${normalized.slice(fm.end).replace(/^\n+/, '')}`;
		return restoreLineEndings(next, hadCrLf);
	}
	return restoreLineEndings(`${insert}${normalized.replace(/^\n+/, '')}`, hadCrLf);
}

export function renderProfileFileName(profile: BitableSyncProfile, recordId: string, fields: Record<string, any>): string {
	const values: Record<string, string> = {
		record_id: recordId,
		title: resolveProfileTitleText(profile, recordId, fields)
	};
	for (const key of [...getProfileFrontMatterFields(profile), ...getProfileBodyFields(profile), 'priority', 'category']) {
		const value = getProfileFieldValue(fields, profile, key);
		if (value !== undefined) {
			values[key] = bitableFieldToPlainText(value).trim();
		}
	}
	const rawName = renderTemplate(profile.fileNameTemplate || '{{title}}', values).trim() || recordId;
	return sanitizeFileName(rawName);
}

export function extractFrontMatterObject(content: string): Record<string, any> {
	const normalized = normalizeLineEndings(content);
	const range = getFrontMatterRange(normalized);
	if (!range) {
		return {};
	}
	const result: Record<string, any> = {};
	const lines = getFrontMatterText(normalized, range).split('\n');
	for (const line of lines) {
		const match = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
		if (!match) {
			continue;
		}
		result[match[1]] = parseFrontMatterScalar(match[2]);
	}
	return result;
}

export function upsertFrontMatterFields(content: string, fields: Record<string, any>): string {
	const hadCrLf = /\r\n/.test(content);
	const normalized = normalizeLineEndings(content);
	const entries = Object.entries(fields).filter(([key, value]) => String(key || '').trim() && value !== undefined);
	if (!entries.length) {
		return content;
	}
	const range = getFrontMatterRange(normalized);
	if (!range) {
		const fm = entries.map(([key, value]) => `${key}: ${formatFrontMatterValue(value)}`).join('\n');
		return restoreLineEndings(`---\n${fm}\n---\n${normalized}`, hadCrLf);
	}
	const fmLines = getFrontMatterText(normalized, range).split('\n');
	for (const [key, value] of entries) {
		const keyRe = new RegExp(`^${escapeRegExp(key)}\\s*:`);
		let replaced = false;
		for (let i = 0; i < fmLines.length; i++) {
			if (keyRe.test(fmLines[i])) {
				fmLines[i] = `${key}: ${formatFrontMatterValue(value)}`;
				replaced = true;
				break;
			}
		}
		if (!replaced) {
			fmLines.push(`${key}: ${formatFrontMatterValue(value)}`);
		}
	}
	return restoreLineEndings(`---\n${fmLines.join('\n')}\n---\n${normalized.slice(range.end)}`, hadCrLf);
}

export function stripFrontMatter(content: string): string {
	const normalized = normalizeLineEndings(content);
	const range = getFrontMatterRange(normalized);
	return range ? normalized.slice(range.end).replace(/^\n+/, '') : normalized;
}

export function stableStringifyProfile(value: any): string {
	if (value === null || value === undefined) {
		return 'null';
	}
	if (Array.isArray(value)) {
		return `[${value.map((item) => stableStringifyProfile(item)).join(',')}]`;
	}
	if (typeof value === 'object') {
		const keys = Object.keys(value).sort();
		return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringifyProfile(value[key])}`).join(',')}}`;
	}
	return JSON.stringify(value);
}

function getProfileFrontMatterFields(profile: BitableSyncProfile): string[] {
	return normalizeStringList(profile.frontmatterFields).length
		? normalizeStringList(profile.frontmatterFields)
		: PROFILE_FRONTMATTER_FIELDS;
}

function getProfileBodyFields(profile: BitableSyncProfile): string[] {
	const fields = normalizeStringList(profile.bodyFields);
	return fields.length ? fields : ['body'];
}

function getPrimaryBodyField(profile: BitableSyncProfile): string {
	return String(profile.primaryBodyField || '').trim() || getProfileBodyFields(profile)[0] || 'body';
}

function mapRemoteStatus(profile: BitableSyncProfile, status: string): string {
	const text = String(status || '').trim();
	return (profile.statusMapping && profile.statusMapping[text]) || text;
}

function mapLocalStatusToRemote(profile: BitableSyncProfile, status: any): string {
	const text = String(status || '').trim();
	if (!text) {
		return '';
	}
	if (profile.reverseStatusMapping && profile.reverseStatusMapping[text]) {
		return profile.reverseStatusMapping[text];
	}
	const reverse = Object.fromEntries(
		Object.entries(profile.statusMapping || {}).map(([remote, local]) => [String(local), String(remote)])
	);
	return reverse[text] || text;
}

function profileFieldToFrontMatterValue(value: any, key: string): string | number | boolean | string[] | undefined {
	if (key === 'review_required') {
		if (typeof value === 'boolean') {
			return value;
		}
		const text = bitableFieldToPlainText(value).trim().toLowerCase();
		if (!text) {
			return undefined;
		}
		return text === 'true' || text === '1' || text === 'yes' || text === 'on' || text === '是' || text === '需要';
	}
	if (key === 'related') {
		return bitableFieldToFrontMatterValue(value, 4);
	}
	return bitableFieldToFrontMatterValue(value);
}

function renderTemplate(template: string, values: Record<string, string>): string {
	return String(template || '').replace(/\{\{\s*([A-Za-z0-9_-]+)\s*\}\}/g, (_match, key) => {
		return values[String(key)] || '';
	});
}

function resolveFieldNameFromAvailable(availableFieldNames: Set<string>, candidates: string[]): string {
	for (const candidate of candidates) {
		if (availableFieldNames.has(candidate)) {
			return candidate;
		}
	}
	const comparable = buildComparableFieldNameMap(availableFieldNames);
	for (const candidate of candidates) {
		const normalized = normalizeComparableFieldName(candidate);
		if (!normalized) {
			continue;
		}
		const match = comparable.get(normalized);
		if (match) {
			return match;
		}
	}
	return '';
}

function resolveFieldNameFromFields(fields: Record<string, any>, candidates: string[]): string {
	for (const candidate of candidates) {
		if (Object.prototype.hasOwnProperty.call(fields, candidate)) {
			return candidate;
		}
	}
	const comparable = buildComparableFieldNameMap(Object.keys(fields || {}));
	for (const candidate of candidates) {
		const normalized = normalizeComparableFieldName(candidate);
		if (!normalized) {
			continue;
		}
		const match = comparable.get(normalized);
		if (match) {
			return match;
		}
	}
	return '';
}

function resolveProfileTitleText(profile: BitableSyncProfile, recordId: string, fields: Record<string, any>): string {
	const mappedTitle = bitableFieldToPlainText(getProfileFieldValue(fields, profile, 'title')).trim();
	if (mappedTitle) {
		return mappedTitle;
	}
	const fallbackField = resolveFieldNameFromFields(fields, ['标题', '名称', '主题', 'name', 'title', 'subject']);
	if (fallbackField) {
		const fallbackValue = bitableFieldToPlainText(fields[fallbackField]).trim();
		if (fallbackValue) {
			return fallbackValue;
		}
	}
	for (const value of Object.values(fields || {})) {
		const text = bitableFieldToPlainText(value).trim();
		if (text) {
			return text;
		}
	}
	return recordId || 'untitled';
}

function buildFallbackProfileBody(
	profile: BitableSyncProfile,
	fields: Record<string, any>,
	fieldMetaByName?: Map<string, BitableFieldMeta>
): string {
	const titleFieldName = resolveFieldNameFromFields(fields, getProfileFieldCandidates(profile, 'title'));
	const titleFieldKey = normalizeComparableFieldName(titleFieldName);
	const orderedEntries = getOrderedFieldEntries(profile, fields, fieldMetaByName);
	const sections: string[] = [];
	for (const [fieldName, value] of orderedEntries) {
		const text = bitableFieldToDisplayText(value, fieldMetaByName?.get(fieldName)).trim();
		if (!text) {
			continue;
		}
		const comparableName = normalizeComparableFieldName(fieldName);
		if (titleFieldKey && comparableName === titleFieldKey) {
			continue;
		}
		const label = stripDecorativeFieldPrefix(fieldName) || String(fieldName || '').trim();
		if (!label) {
			continue;
		}
		sections.push(`## ${label}\n${text}`);
	}
	if (sections.length > 0) {
		return sections.join('\n\n').trim();
	}
	return resolveProfileTitleText(profile, '', fields).trim();
}

function getOrderedFieldEntries(
	profile: BitableSyncProfile,
	fields: Record<string, any>,
	fieldMetaByName?: Map<string, BitableFieldMeta>
): Array<[string, any]> {
	const entries = Object.entries(fields || {});
	if (!entries.length) {
		return [];
	}
	const preferredOrder = [
		...normalizeStringList(profile.fieldNamesCache),
		...(fieldMetaByName && fieldMetaByName.size ? Array.from(fieldMetaByName.keys()) : [])
	];
	if (!preferredOrder.length) {
		return entries;
	}
	const ordered: Array<[string, any]> = [];
	const seen = new Set<string>();
	for (const preferredName of preferredOrder) {
		const actualFieldName = resolveFieldNameFromFields(fields, [preferredName]);
		if (!actualFieldName || seen.has(actualFieldName)) {
			continue;
		}
		ordered.push([actualFieldName, fields[actualFieldName]]);
		seen.add(actualFieldName);
	}
	for (const [fieldName, value] of entries) {
		if (!seen.has(fieldName)) {
			ordered.push([fieldName, value]);
		}
	}
	return ordered;
}

function normalizeProfileFieldMapping(input: any): BitableSyncProfile['fieldMapping'] {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		return {};
	}
	const result: Record<string, string | string[]> = {};
	for (const [key, value] of Object.entries(input)) {
		const logicalKey = String(key || '').trim();
		if (!logicalKey) {
			continue;
		}
		if (Array.isArray(value)) {
			const items = value.map((item) => String(item || '').trim()).filter((item) => !!item);
			if (items.length) {
				result[logicalKey] = items;
			}
			continue;
		}
		const fieldName = String(value || '').trim();
		if (fieldName) {
			result[logicalKey] = fieldName;
		}
	}
	return result;
}

function normalizeStringRecord(input: any): Record<string, string> {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		return {};
	}
	return Object.fromEntries(
		Object.entries(input)
			.map(([key, value]) => [String(key || '').trim(), String(value || '').trim()])
			.filter(([key, value]) => !!key && !!value)
	);
}

function normalizeStringList(input: any): string[] {
	if (!Array.isArray(input)) {
		return [];
	}
	return input.map((item) => String(item || '').trim()).filter((item) => !!item);
}

function buildComparableFieldNameMap(fieldNames: Iterable<string>): Map<string, string> {
	const result = new Map<string, string>();
	for (const fieldName of fieldNames) {
		const normalized = normalizeComparableFieldName(fieldName);
		if (normalized && !result.has(normalized)) {
			result.set(normalized, fieldName);
		}
	}
	return result;
}

function normalizeComparableFieldName(value: string): string {
	return String(value || '')
		.normalize('NFKC')
		.replace(/[\u200d\uFE0F]/g, '')
		.replace(/^[^0-9A-Za-z\u4E00-\u9FFF]+/gu, '')
		.replace(/\s+/g, '')
		.toLowerCase()
		.trim();
}

function stripDecorativeFieldPrefix(value: string): string {
	const cleaned = String(value || '')
		.replace(/[\u200d\uFE0F]/g, '')
		.replace(/^[^0-9A-Za-z\u4E00-\u9FFF]+/gu, '')
		.trim();
	return cleaned || String(value || '').trim();
}

function parseFrontMatterScalar(value: string): any {
	const text = String(value || '').trim();
	if (!text) {
		return '';
	}
	try {
		if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith('[') && text.endsWith(']')) || (text.startsWith('{') && text.endsWith('}'))) {
			return JSON.parse(text);
		}
	} catch {
		return text.replace(/^["']|["']$/g, '');
	}
	if (text === 'true') {
		return true;
	}
	if (text === 'false') {
		return false;
	}
	if (/^-?\d+(\.\d+)?$/.test(text)) {
		const numberValue = Number(text);
		if (Number.isFinite(numberValue)) {
			return numberValue;
		}
	}
	return text.replace(/^["']|["']$/g, '');
}

function formatFrontMatterValue(value: any): string {
	if (Array.isArray(value)) {
		return JSON.stringify(value);
	}
	if (typeof value === 'number' || typeof value === 'boolean') {
		return String(value);
	}
	const text = String(value ?? '');
	if (/^(true|false|null|-?\d+(\.\d+)?)$/i.test(text)) {
		return JSON.stringify(text);
	}
	return JSON.stringify(text);
}

function getFrontMatterRange(normalizedContent: string): { start: number; end: number } | null {
	if (!normalizedContent.startsWith('---\n')) {
		return null;
	}
	const endMarker = normalizedContent.indexOf('\n---\n', 4);
	if (endMarker < 0) {
		if (normalizedContent.endsWith('\n---')) {
			return { start: 4, end: normalizedContent.length };
		}
		return null;
	}
	return { start: 4, end: endMarker + 5 };
}

function getFrontMatterText(normalizedContent: string, range: { start: number; end: number }): string {
	return normalizedContent
		.slice(range.start, range.end)
		.replace(/\n---\n?$/, '')
		.replace(/\n+$/g, '');
}

function getProfileBlockStart(profile: BitableSyncProfile): string {
	return `<!-- feishu-share:bitable-profile:${profile.id}:begin -->`;
}

function getProfileBlockEnd(profile: BitableSyncProfile): string {
	return `<!-- feishu-share:bitable-profile:${profile.id}:end -->`;
}

function normalizeVaultPath(path: string): string {
	return String(path || '')
		.replace(/\\/g, '/')
		.replace(/^\/+/, '')
		.replace(/\/+$/, '')
		.replace(/\/{2,}/g, '/')
		.trim();
}

function normalizeLineEndings(content: string): string {
	return String(content || '').replace(/\r\n/g, '\n');
}

function restoreLineEndings(content: string, useCrLf: boolean): string {
	return useCrLf ? content.replace(/\n/g, '\r\n') : content;
}

function normalizeTrailingNewline(content: string): string {
	return `${String(content || '').replace(/\s+$/g, '')}\n`;
}

function sanitizeFileName(name: string): string {
	const sanitized = String(name || '')
		.replace(/[\\/:*?"<>|#^[\]]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 120);
	return sanitized || 'untitled';
}

function escapeRegExp(value: string): string {
	return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
