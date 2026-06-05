import type { BitableFieldMeta } from './types';

const STRUCTURED_BTABLE_FIELD_TYPES = new Set([11, 15, 17, 18, 19, 21, 22, 23]);

function tryParseJsonString(value: string): any {
	const trimmed = String(value || '').trim();
	if (!trimmed) {
		return null;
	}
	if (!((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']')))) {
		return null;
	}
	try {
		return JSON.parse(trimmed);
	} catch {
		return null;
	}
}

function normalizeStringList(value: any): string[] {
	if (Array.isArray(value)) {
		return value
			.map((item) => bitableFieldToPlainText(item).trim())
			.filter((item) => item.length > 0);
	}
	if (typeof value === 'string') {
		return value
			.split(/[\n,;]+/)
			.map((item) => item.trim())
			.filter((item) => item.length > 0);
	}
	const text = bitableFieldToPlainText(value).trim();
	return text ? [text] : [];
}

export function bitableFieldToPlainText(value: any): string {
	if (value === undefined || value === null) return '';
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	if (Array.isArray(value)) {
		return value.map((item) => bitableFieldToPlainText(item)).filter((item) => item.length > 0).join(', ');
	}
	if (typeof value === 'object') {
		if (typeof value.text === 'string' && value.text.trim()) return value.text;
		if (typeof value.name === 'string' && value.name.trim()) return value.name;
		if (typeof value.link === 'string' && value.link.trim()) return value.link;
		if (typeof value.url === 'string' && value.url.trim()) return value.url;
		if (typeof value.href === 'string' && value.href.trim()) return value.href;
		if (typeof value.email === 'string' && value.email.trim()) return value.email;
		if (typeof value.en_name === 'string' && value.en_name.trim()) return value.en_name;
		if (typeof value.value === 'string' && value.value.trim()) return value.value;
		if (Array.isArray(value.link_record_ids)) return value.link_record_ids.join(', ');
		if (Array.isArray(value.record_ids)) return value.record_ids.filter((item: any) => item !== undefined && item !== null && String(item).trim()).join(', ');
		if (Array.isArray(value.text_arr)) {
			const textArr = value.text_arr
				.map((item: any) => bitableFieldToPlainText(item).trim())
				.filter((item: string) => item.length > 0);
			if (textArr.length > 0) {
				return textArr.join(', ');
			}
		}
		if (isEmptyStructuredBitableObject(value)) return '';
	}
	return JSON.stringify(value);
}

export function bitableFieldToDisplayText(value: any, fieldMeta?: BitableFieldMeta): string {
	if (value === undefined || value === null) {
		return '';
	}
	if (fieldMeta?.type === 5) {
		return formatBitableDateDisplay(value);
	}
	if ((typeof value === 'number' && looksLikeTimestamp(value)) || (typeof value === 'string' && looksLikeTimestampString(value))) {
		const maybeDate = formatBitableDateDisplay(value);
		if (maybeDate) {
			return maybeDate;
		}
	}
	return bitableFieldToPlainText(value);
}

export function bitableFieldToFrontMatterValue(value: any, fieldType?: number): string | number | boolean | string[] | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	if (fieldType === 4) {
		const items = normalizeStringList(value);
		return items.length ? items : undefined;
	}
	if (fieldType === 7) {
		if (typeof value === 'boolean') return value;
		const text = bitableFieldToPlainText(value).trim().toLowerCase();
		if (!text) return undefined;
		return text === 'true' || text === '1' || text === 'yes';
	}
	if (fieldType === 2) {
		const numeric = typeof value === 'number' ? value : Number(bitableFieldToPlainText(value).trim());
		return Number.isFinite(numeric) ? numeric : undefined;
	}
	const text = bitableFieldToPlainText(value).trim();
	return text || undefined;
}

export function normalizeBitableWriteValue(value: any, fieldMeta?: BitableFieldMeta, now: number = Date.now()): any {
	if (value === undefined || value === null || !fieldMeta) {
		return value;
	}
	const { type } = fieldMeta;

	if (STRUCTURED_BTABLE_FIELD_TYPES.has(type) && typeof value === 'string') {
		const parsed = tryParseJsonString(value);
		if (parsed !== null) {
			return parsed;
		}
	}

	if (type === 1) {
		return bitableFieldToPlainText(value);
	}

	if (type === 2) {
		const numeric = typeof value === 'number' ? value : Number(bitableFieldToPlainText(value).trim());
		return Number.isFinite(numeric) ? numeric : 0;
	}

	if (type === 3) {
		return bitableFieldToPlainText(value).trim();
	}

	if (type === 4) {
		return normalizeStringList(value);
	}

	if (type === 5) {
		if (typeof value === 'number' && Number.isFinite(value)) {
			return value;
		}
		const parsed = Date.parse(bitableFieldToPlainText(value).trim());
		return Number.isFinite(parsed) ? parsed : now;
	}

	if (type === 7) {
		if (typeof value === 'boolean') return value;
		if (typeof value === 'number') return value !== 0;
		const normalized = bitableFieldToPlainText(value).trim().toLowerCase();
		return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
	}

	if (type === 11) {
		if (Array.isArray(value)) return value;
		const items = normalizeStringList(value);
		return items.length ? items.map((id) => ({ id })) : value;
	}

	if (type === 15) {
		if (value && typeof value === 'object') return value;
		const text = bitableFieldToPlainText(value).trim();
		if (!text) return '';
		const markdownLink = text.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/);
		if (markdownLink) {
			return {
				text: markdownLink[1].trim(),
				link: markdownLink[2].trim()
			};
		}
		return {
			text,
			link: text
		};
	}

	if (type === 18) {
		if (value && typeof value === 'object') return value;
		const ids = normalizeStringList(value);
		return ids.length ? { link_record_ids: ids } : value;
	}

	return value;
}

function formatBitableDateDisplay(value: any): string {
	const timestamp = parseTimestampValue(value);
	if (!Number.isFinite(timestamp)) {
		return bitableFieldToPlainText(value);
	}
	const date = new Date(timestamp);
	if (!Number.isFinite(date.getTime())) {
		return bitableFieldToPlainText(value);
	}
	const yyyy = date.getFullYear();
	const mm = String(date.getMonth() + 1).padStart(2, '0');
	const dd = String(date.getDate()).padStart(2, '0');
	const hh = String(date.getHours()).padStart(2, '0');
	const min = String(date.getMinutes()).padStart(2, '0');
	const sec = String(date.getSeconds()).padStart(2, '0');
	const hasTime = date.getHours() !== 0 || date.getMinutes() !== 0 || date.getSeconds() !== 0 || date.getMilliseconds() !== 0;
	if (!hasTime) {
		return `${yyyy}/${mm}/${dd}`;
	}
	return date.getSeconds() === 0 && date.getMilliseconds() === 0
		? `${yyyy}/${mm}/${dd} ${hh}:${min}`
		: `${yyyy}/${mm}/${dd} ${hh}:${min}:${sec}`;
}

function parseTimestampValue(value: any): number {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === 'string') {
		const trimmed = value.trim();
		if (/^\d{12,14}$/.test(trimmed)) {
			const numeric = Number(trimmed);
			return Number.isFinite(numeric) ? numeric : NaN;
		}
		const parsed = Date.parse(trimmed);
		return Number.isFinite(parsed) ? parsed : NaN;
	}
	return NaN;
}

function looksLikeTimestamp(value: number): boolean {
	return Number.isFinite(value) && Math.abs(value) >= 1e11 && Math.abs(value) < 1e14;
}

function looksLikeTimestampString(value: string): boolean {
	return /^\d{12,14}$/.test(String(value || '').trim());
}

function isEmptyStructuredBitableObject(value: Record<string, any>): boolean {
	const relevantKeys = ['text', 'name', 'link', 'url', 'href', 'email', 'en_name', 'value', 'record_ids', 'link_record_ids', 'text_arr'];
	const hasStructuredShape = relevantKeys.some((key) => Object.prototype.hasOwnProperty.call(value, key));
	if (!hasStructuredShape) {
		return false;
	}
	for (const key of ['text', 'name', 'link', 'url', 'href', 'email', 'en_name', 'value']) {
		if (typeof value[key] === 'string' && value[key].trim()) {
			return false;
		}
	}
	for (const key of ['record_ids', 'link_record_ids']) {
		if (Array.isArray(value[key]) && value[key].some((item: any) => item !== undefined && item !== null && String(item).trim())) {
			return false;
		}
	}
	if (Array.isArray(value.text_arr)) {
		const textArr = value.text_arr
			.map((item: any) => bitableFieldToPlainText(item).trim())
			.filter((item: string) => item.length > 0);
		if (textArr.length > 0) {
			return false;
		}
	}
	return true;
}
