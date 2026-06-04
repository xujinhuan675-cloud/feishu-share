export interface FeishuConvertedBlocksData {
	first_level_block_ids?: string[];
	blocks?: Record<string, any>;
}

const FEISHU_SPECIAL_LINK_LABELS = new Set([
	'Bitable',
	'ChatCard',
	'Iframe',
	'Mindnote',
	'Sheet'
]);

function stripMergeInfo(value: any): any {
	if (Array.isArray(value)) {
		return value.map((item) => stripMergeInfo(item));
	}
	if (!value || typeof value !== 'object') {
		return value;
	}

	const next: Record<string, any> = {};
	for (const [key, child] of Object.entries(value)) {
		if (key === 'merge_info') {
			continue;
		}
		next[key] = stripMergeInfo(child);
	}
	return next;
}

export function shouldPreserveFeishuSpecialLink(label: string, url: string): boolean {
	const cleanLabel = String(label || '').trim();
	const cleanUrl = String(url || '').trim();
	if (!cleanLabel || !cleanUrl) {
		return false;
	}
	if (cleanLabel === 'Iframe') {
		return /^https?:\/\//i.test(cleanUrl);
	}
	return FEISHU_SPECIAL_LINK_LABELS.has(cleanLabel);
}

export function buildDescendantPayloadFromConvertedData(data: FeishuConvertedBlocksData): {
	children_id: string[];
	descendants: any[];
} {
	const children_id = Array.isArray(data?.first_level_block_ids)
		? data.first_level_block_ids.filter((id): id is string => typeof id === 'string' && id.length > 0)
		: [];
	const blockMap = data?.blocks && typeof data.blocks === 'object' ? data.blocks : {};

	const orderedIds: string[] = [];
	const visited = new Set<string>();

	const visit = (blockId: string) => {
		if (!blockId || visited.has(blockId)) {
			return;
		}
		const block = blockMap[blockId];
		if (!block || typeof block !== 'object') {
			return;
		}
		visited.add(blockId);
		orderedIds.push(blockId);
		const children = Array.isArray(block.children) ? block.children : [];
		for (const childId of children) {
			if (typeof childId === 'string' && childId.length > 0) {
				visit(childId);
			}
		}
	};

	for (const blockId of children_id) {
		visit(blockId);
	}
	for (const blockId of Object.keys(blockMap)) {
		visit(blockId);
	}

	return {
		children_id,
		descendants: orderedIds.map((blockId) => stripMergeInfo(blockMap[blockId]))
	};
}

export function collectDocxUploadCompatibilityWarnings(content: string): string[] {
	const warnings: string[] = [];
	const text = String(content || '');

	if (/\[Mindnote\]\(([^)]+)\)/.test(text)) {
		warnings.push('检测到 Mindnote 占位语法；飞书开放平台当前不支持通过公开 API 还原为原生思维笔记块。');
	}

	if (/\[(?:Bitable|Sheet)\]\(([^)]+)\)/.test(text)) {
		warnings.push('检测到 Bitable/Sheet 占位语法；飞书开放平台当前无法稳定按原嵌入块完整回推。');
	}

	if (/\[(?:Diagram:[^\]]+|Widget:[^\]]+)\]/.test(text)) {
		warnings.push('检测到飞书图表/小组件占位语法；公开 API 当前无法稳定重建为原生块。');
	}

	return warnings;
}
