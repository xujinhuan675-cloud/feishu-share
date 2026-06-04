import type { LocalFileInfo } from './types';

export const FEISHU_MERMAID_COMPONENT_TYPE_ID = 'blk_631fefbbae02400430b8f9f4';

export type GeneratedDocStructure = {
	children_id: string[];
	descendants: any[];
};

type GeneratedDocBlockBuildResult =
	| { kind: 'block'; block: any }
	| { kind: 'structure'; structure: GeneratedDocStructure };

type SupportedGeneratedFileInfo = Pick<
	LocalFileInfo,
	'generatedType' | 'generatedSource' | 'generatedMeta'
>;

export function buildGeneratedDocBlock(
	fileInfo: SupportedGeneratedFileInfo
): GeneratedDocBlockBuildResult | null {
	switch (fileInfo.generatedType) {
		case 'mermaid':
			return {
				kind: 'block',
				block: buildMermaidBlock(fileInfo.generatedSource || '')
			};
		case 'whiteboard':
			return {
				kind: 'block',
				block: buildWhiteboardBlock(fileInfo.generatedMeta)
			};
		case 'table':
			return {
				kind: 'structure',
				structure: buildTableStructure(fileInfo.generatedMeta)
			};
		default:
			return null;
	}
}

export function buildMermaidBlock(code: string): any {
	return {
		block_type: 40,
		add_ons: {
			component_id: '',
			component_type_id: FEISHU_MERMAID_COMPONENT_TYPE_ID,
			record: JSON.stringify({
				data: normalizeMultilineSource(code)
			})
		}
	};
}

export function buildWhiteboardBlock(meta?: Record<string, any>): any {
	const align = normalizeWhiteboardAlign(meta?.align);
	return {
		block_type: 43,
		board: {
			align
		}
	};
}

export function buildTableStructure(meta?: Record<string, any>): GeneratedDocStructure {
	const table = normalizeTableMeta(meta);
	const tableId = createGeneratedBlockId('table');
	const descendants: any[] = [];
	const cellIds: string[] = [];
	const mergeInfo = new Array(table.rowSize * table.columnSize).fill({});

	for (let row = 0; row < table.rowSize; row++) {
		for (let col = 0; col < table.columnSize; col++) {
			const cellId = `${tableId}_cell_${row}_${col}`;
			const childId = `${cellId}_text`;
			const cell = table.rows[row]?.[col];
			const rowSpan = clampPositiveInt(cell?.rowSpan, 1);
			const colSpan = clampPositiveInt(cell?.colSpan, 1);
			const mergeIndex = row * table.columnSize + col;

			if (rowSpan > 1 || colSpan > 1) {
				mergeInfo[mergeIndex] = {
					row_span: rowSpan,
					col_span: colSpan
				};
			}

			cellIds.push(cellId);
			descendants.push({
				block_id: cellId,
				block_type: 32,
				table_cell: {},
				children: [childId]
			});
			descendants.push({
				block_id: childId,
				block_type: 2,
				text: {
					elements: [{
						text_run: {
							content: normalizeTableCellText(cell?.content || '')
						}
					}]
				},
				children: []
			});
		}
	}

	descendants.unshift({
		block_id: tableId,
		block_type: 31,
		table: {
			property: {
				row_size: table.rowSize,
				column_size: table.columnSize,
				merge_info: mergeInfo
			}
		},
		children: cellIds
	});

	return {
		children_id: [tableId],
		descendants
	};
}

export function normalizeMultilineSource(code: string): string {
	return String(code || '')
		.replace(/\r\n?/g, '\n')
		.replace(/^\n+/, '')
		.replace(/\n+$/, '');
}

export function extractGeneratedDocBlocks(
	content: string,
	createPlaceholder: () => string
): { content: string; localFiles: LocalFileInfo[] } {
	let nextContent = String(content || '');
	const localFiles: LocalFileInfo[] = [];

	const pushGeneratedFile = (file: LocalFileInfo) => {
		localFiles.push(file);
	};

	nextContent = extractMermaidBlocks(nextContent, createPlaceholder, pushGeneratedFile);
	nextContent = extractWhiteboardBlocks(nextContent, createPlaceholder, pushGeneratedFile);
	nextContent = extractHtmlTables(nextContent, createPlaceholder, pushGeneratedFile);

	localFiles.sort((a, b) => {
		const indexA = Number(a.generatedMeta?.sourceIndex ?? Number.MAX_SAFE_INTEGER);
		const indexB = Number(b.generatedMeta?.sourceIndex ?? Number.MAX_SAFE_INTEGER);
		if (indexA !== indexB) {
			return indexA - indexB;
		}
		return a.placeholder.localeCompare(b.placeholder);
	});

	return {
		content: nextContent,
		localFiles
	};
}

function extractMermaidBlocks(
	content: string,
	createPlaceholder: () => string,
	pushGeneratedFile: (file: LocalFileInfo) => void
): string {
	const mermaidFenceRegex = /(^|\n)([ \t]*)(```|~~~)\s*(mermaid(?:[^\n]*))\n([\s\S]*?)\n\2\3\s*(?=\n|$)/gi;

	return String(content || '').replace(
		mermaidFenceRegex,
		(_match, leading, indent, _fence, info, body, offset) => {
			const placeholder = createPlaceholder();
			pushGeneratedFile({
				originalPath: `generated://mermaid/${placeholder}`,
				fileName: 'mermaid.mmd',
				placeholder,
				isImage: false,
				generatedType: 'mermaid',
				generatedSource: stripFenceIndent(String(body || ''), String(indent || '')),
				generatedFenceInfo: String(info || '').trim(),
				generatedIndent: String(indent || ''),
				generatedMeta: {
					sourceIndex: Number(offset) || 0
				}
			});
			return `${leading || ''}${indent || ''}${placeholder}`;
		}
	);
}

function extractWhiteboardBlocks(
	content: string,
	createPlaceholder: () => string,
	pushGeneratedFile: (file: LocalFileInfo) => void
): string {
	const whiteboardRegex = /(^|\n)([ \t]*)\[Whiteboard(?::([^\]\n]+))?\](?=\n|$)/gi;

	return String(content || '').replace(whiteboardRegex, (_match, leading, indent, token, offset) => {
		const placeholder = createPlaceholder();
		pushGeneratedFile({
			originalPath: `generated://whiteboard/${placeholder}`,
			fileName: 'whiteboard.board',
			placeholder,
			isImage: false,
			generatedType: 'whiteboard',
			generatedMeta: {
				sourceIndex: Number(offset) || 0,
				token: token ? String(token).trim() : '',
				align: 1
			}
		});
		return `${leading || ''}${indent || ''}${placeholder}`;
	});
}

function extractHtmlTables(
	content: string,
	createPlaceholder: () => string,
	pushGeneratedFile: (file: LocalFileInfo) => void
): string {
	const tableRegex = /(^|\n)([ \t]*)(<table>[\s\S]*?<\/table>)(?=\n|$)/gi;

	return String(content || '').replace(tableRegex, (_match, leading, indent, tableHtml, offset) => {
		const parsed = parseHtmlTable(tableHtml);
		if (!parsed) {
			return `${leading || ''}${indent || ''}${tableHtml}`;
		}

		const placeholder = createPlaceholder();
		pushGeneratedFile({
			originalPath: `generated://table/${placeholder}`,
			fileName: 'table.html',
			placeholder,
			isImage: false,
			generatedType: 'table',
			generatedSource: normalizeMultilineSource(tableHtml),
			generatedMeta: {
				...parsed,
				sourceIndex: Number(offset) || 0
			}
		});
		return `${leading || ''}${indent || ''}${placeholder}`;
	});
}

function stripFenceIndent(body: string, indent: string): string {
	const normalized = normalizeMultilineSource(body);
	if (!indent) {
		return normalized;
	}

	return normalized
		.split('\n')
		.map((line) => {
			if (!line) {
				return line;
			}
			return line.startsWith(indent) ? line.slice(indent.length) : line;
		})
		.join('\n');
}

function normalizeWhiteboardAlign(value: any): 1 | 2 | 3 {
	if (value === 2 || value === 3) {
		return value;
	}
	return 1;
}

function normalizeTableMeta(meta?: Record<string, any>): {
	rowSize: number;
	columnSize: number;
	rows: Array<Array<{ content: string; rowSpan?: number; colSpan?: number }>>;
} {
	const rawRows = Array.isArray(meta?.rows) ? meta.rows : [];
	const rows = rawRows.map((row: any) => {
		if (!Array.isArray(row)) {
			return [];
		}
		return row.map((cell: any) => ({
			content: normalizeTableCellText(cell?.content || ''),
			rowSpan: clampPositiveInt(cell?.rowSpan, 1),
			colSpan: clampPositiveInt(cell?.colSpan, 1)
		}));
	});

	const rowSize = Math.max(1, rows.length || clampPositiveInt(meta?.rowSize, 1));
	const columnSize = Math.max(
		1,
		rows.reduce((max, row) => Math.max(max, Array.isArray(row) ? row.length : 0), 0) || clampPositiveInt(meta?.columnSize, 1)
	);

	const normalizedRows: Array<Array<{ content: string; rowSpan?: number; colSpan?: number }>> = [];
	for (let rowIndex = 0; rowIndex < rowSize; rowIndex++) {
		const row = rows[rowIndex] || [];
		const normalizedRow = [];
		for (let colIndex = 0; colIndex < columnSize; colIndex++) {
			const cell = row[colIndex];
			normalizedRow.push({
				content: normalizeTableCellText(cell?.content || ''),
				rowSpan: clampPositiveInt(cell?.rowSpan, 1),
				colSpan: clampPositiveInt(cell?.colSpan, 1)
			});
		}
		normalizedRows.push(normalizedRow);
	}

	return {
		rowSize,
		columnSize,
		rows: normalizedRows
	};
}

function normalizeTableCellText(value: string): string {
	return decodeHtmlEntities(
		String(value || '')
			.replace(/<br\s*\/?>/gi, '\n')
			.replace(/<\/?(?:p|div|span|strong|em|code|u|mark|thead|tbody)>/gi, '')
			.replace(/\r\n?/g, '\n')
			.replace(/\n{3,}/g, '\n\n')
			.trim()
	);
}

function parseHtmlTable(html: string): Record<string, any> | null {
	const tableHtml = String(html || '').trim();
	if (!/^<table>/i.test(tableHtml) || !/<\/table>$/i.test(tableHtml)) {
		return null;
	}

	const rowMatches = Array.from(tableHtml.matchAll(/<tr>([\s\S]*?)<\/tr>/gi));
	if (rowMatches.length === 0) {
		return null;
	}

	const rows = rowMatches.map((match) => {
		const rowHtml = String(match[1] || '');
		const cellMatches = Array.from(rowHtml.matchAll(/<td([^>]*)>([\s\S]*?)<\/td>/gi));
		return cellMatches.map((cellMatch) => {
			const attrs = String(cellMatch[1] || '');
			const content = String(cellMatch[2] || '');
			return {
				content: normalizeTableCellText(content),
				rowSpan: extractSpan(attrs, 'rowspan'),
				colSpan: extractSpan(attrs, 'colspan')
			};
		});
	});

	const columnSize = rows.reduce((max, row) => Math.max(max, row.length), 0);
	if (columnSize === 0) {
		return null;
	}

	return {
		rowSize: rows.length,
		columnSize,
		rows
	};
}

function extractSpan(attrs: string, name: 'rowspan' | 'colspan'): number {
	const match = String(attrs || '').match(new RegExp(`${name}\\s*=\\s*["']?(\\d+)["']?`, 'i'));
	return clampPositiveInt(match?.[1], 1);
}

function clampPositiveInt(value: any, fallback: number): number {
	const numeric = Number(value);
	if (!Number.isFinite(numeric) || numeric < 1) {
		return fallback;
	}
	return Math.floor(numeric);
}

function createGeneratedBlockId(prefix: string): string {
	return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function decodeHtmlEntities(text: string): string {
	return String(text || '')
		.replace(/&nbsp;/gi, ' ')
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&amp;/gi, '&')
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'");
}
