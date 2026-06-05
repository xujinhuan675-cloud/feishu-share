import type { LocalFileInfo } from './types';

export const FEISHU_MERMAID_COMPONENT_TYPE_ID = 'blk_631fefbbae02400430b8f9f4';

export type GeneratedDocStructure = {
	children_id: string[];
	descendants: any[];
};

export type TableMergeRange = {
	row_start_index: number;
	row_end_index: number;
	column_start_index: number;
	column_end_index: number;
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
		case 'todo':
			return {
				kind: 'block',
				block: buildTodoBlock(fileInfo.generatedSource || '', fileInfo.generatedMeta)
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
		case 'list':
			return {
				kind: 'structure',
				structure: buildListStructure(fileInfo.generatedMeta)
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

export function buildTodoBlock(content: string, meta?: Record<string, any>): any {
	return {
		block_type: 17,
		todo: {
			checked: !!meta?.checked,
			style: {
				align: 1,
				done: !!meta?.checked,
				folded: false
			},
			elements: buildRichTextElements(String(content || '').trim())
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

	for (let row = 0; row < table.rowSize; row++) {
		for (let col = 0; col < table.columnSize; col++) {
			const cellId = `${tableId}_cell_${row}_${col}`;
			const childId = `${cellId}_text`;
			const cell = table.rows[row]?.[col];

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
					elements: buildRichTextElements(cell?.content || '')
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
				column_size: table.columnSize
			}
		},
		children: cellIds
	});

	return {
		children_id: [tableId],
		descendants
	};
}

export function collectTableMergeRanges(meta?: Record<string, any>): TableMergeRange[] {
	const table = normalizeTableMeta(meta);
	const ranges: TableMergeRange[] = [];

	for (let row = 0; row < table.rowSize; row++) {
		for (let col = 0; col < table.columnSize; col++) {
			const cell = table.rows[row]?.[col];
			const rowSpan = clampPositiveInt(cell?.rowSpan, 1);
			const colSpan = clampPositiveInt(cell?.colSpan, 1);

			if (rowSpan > 1 || colSpan > 1) {
				ranges.push({
					row_start_index: row,
					row_end_index: row + rowSpan,
					column_start_index: col,
					column_end_index: col + colSpan
				});
			}
		}
	}

	return ranges;
}

export function buildListStructure(meta?: Record<string, any>): GeneratedDocStructure {
	const nodes = Array.isArray(meta?.nodes) ? meta.nodes : [];
	const descendants: any[] = [];
	const children_id: string[] = [];
	const quoteText = typeof meta?.quoteText === 'string' ? meta.quoteText : '';

	if (meta?.kind === 'quote') {
		const quoteId = createGeneratedBlockId('quote');
		const childIds = buildStructuredNodes(nodes, descendants);
		descendants.unshift({
			block_id: quoteId,
			block_type: 15,
			quote: {
				elements: buildRichTextElements(quoteText)
			},
			children: childIds
		});
		children_id.push(quoteId);
	} else {
		children_id.push(...buildStructuredNodes(nodes, descendants));
	}

	return {
		children_id,
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
	nextContent = extractMarkdownTables(nextContent, createPlaceholder, pushGeneratedFile);
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

export function extractGeneratedListStructures(
	content: string,
	createPlaceholder: () => string
): { content: string; localFiles: LocalFileInfo[] } {
	const lines = String(content || '').split('\n');
	const output: string[] = [];
	const localFiles: LocalFileInfo[] = [];
	let index = 0;
	let sourceOffset = 0;
	let inFence = false;
	let fenceMarker = '';

	while (index < lines.length) {
		const line = String(lines[index] || '');
		const trimmed = line.trim();
		const fenceMatch = line.match(/^\s*(```+|~~~+)/);
		if (fenceMatch) {
			const marker = fenceMatch[1][0];
			if (!inFence) {
				inFence = true;
				fenceMarker = marker;
			} else if (fenceMarker === marker) {
				inFence = false;
				fenceMarker = '';
			}
			output.push(line);
			sourceOffset += line.length + 1;
			index += 1;
			continue;
		}

		if (inFence) {
			output.push(line);
			sourceOffset += line.length + 1;
			index += 1;
			continue;
		}

		const lineOffset = sourceOffset;
		const quoteSection = tryParseQuoteSection(lines, index);
		if (quoteSection) {
			const placeholder = createPlaceholder();
			localFiles.push({
				originalPath: `generated://list/${placeholder}`,
				fileName: 'quote-list.md',
				placeholder,
				isImage: false,
				generatedType: 'list',
				generatedSource: quoteSection.source,
				generatedMeta: {
					...quoteSection.meta,
					sourceIndex: lineOffset
				}
			});
			output.push(placeholder);
			for (let consumed = 0; consumed < quoteSection.lineCount; consumed++) {
				sourceOffset += lines[index + consumed].length + 1;
			}
			index += quoteSection.lineCount;
			continue;
		}

		const listSection = tryParseListSection(lines, index);
		if (listSection) {
			const placeholder = createPlaceholder();
			localFiles.push({
				originalPath: `generated://list/${placeholder}`,
				fileName: 'list.md',
				placeholder,
				isImage: false,
				generatedType: 'list',
				generatedSource: listSection.source,
				generatedMeta: {
					...listSection.meta,
					sourceIndex: lineOffset
				}
			});
			output.push(placeholder);
			for (let consumed = 0; consumed < listSection.lineCount; consumed++) {
				sourceOffset += lines[index + consumed].length + 1;
			}
			index += listSection.lineCount;
			continue;
		}

		output.push(line);
		sourceOffset += line.length + 1;
		index += 1;
	}

	return {
		content: output.join('\n'),
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

function extractMarkdownTables(
	content: string,
	createPlaceholder: () => string,
	pushGeneratedFile: (file: LocalFileInfo) => void
): string {
	const lines = String(content || '').split('\n');
	const output: string[] = [];
	let index = 0;
	let sourceOffset = 0;

	while (index < lines.length) {
		const line = lines[index];
		const lineOffset = sourceOffset;
		const parsed = tryParseMarkdownTableAt(lines, index);

		if (!parsed) {
			output.push(line);
			sourceOffset += line.length + 1;
			index += 1;
			continue;
		}

		const placeholder = createPlaceholder();
		pushGeneratedFile({
			originalPath: `generated://table/${placeholder}`,
			fileName: 'table.md',
			placeholder,
			isImage: false,
			generatedType: 'table',
			generatedSource: parsed.source,
			generatedMeta: {
				...parsed.meta,
				sourceIndex: lineOffset
			}
		});
		output.push(placeholder);

		for (let consumed = 0; consumed < parsed.lineCount; consumed++) {
			sourceOffset += lines[index + consumed].length + 1;
		}
		index += parsed.lineCount;
	}

	return output.join('\n');
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
			.replace(/<strong\b[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**')
			.replace(/<b\b[^>]*>([\s\S]*?)<\/b>/gi, '**$1**')
			.replace(/<em\b[^>]*>([\s\S]*?)<\/em>/gi, '*$1*')
			.replace(/<i\b[^>]*>([\s\S]*?)<\/i>/gi, '*$1*')
			.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')
			.replace(/<u\b[^>]*>([\s\S]*?)<\/u>/gi, '<u>$1</u>')
			.replace(/<mark\b[^>]*>([\s\S]*?)<\/mark>/gi, '==$1==')
			.replace(/<span\s+style=["'][^"']*color\s*:\s*(gray|brown|orange|yellow|green|blue|purple)[^"']*["']\s*>([\s\S]*?)<\/span>/gi, (_m, color, inner) => `<span style="color:${String(color).toLowerCase()}">${inner}</span>`)
			.replace(/<\/?(?:p|div|strong|b|em|i|code|u|mark|thead|tbody|tr|td|th)\b[^>]*>/gi, '')
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

	const pendingRowSpans: number[] = [];
	const rows = rowMatches.map((match) => {
		const rowHtml = String(match[1] || '');
		const cellMatches = Array.from(rowHtml.matchAll(/<td([^>]*)>([\s\S]*?)<\/td>/gi));
		const row: Array<{ content: string; rowSpan?: number; colSpan?: number }> = [];
		let colIndex = 0;

		const consumePendingSpans = () => {
			while ((pendingRowSpans[colIndex] || 0) > 0) {
				row[colIndex] = {
					content: ''
				};
				pendingRowSpans[colIndex] -= 1;
				colIndex += 1;
			}
		};

		for (const cellMatch of cellMatches) {
			consumePendingSpans();
			const attrs = String(cellMatch[1] || '');
			const content = String(cellMatch[2] || '');
			const rowSpan = extractSpan(attrs, 'rowspan');
			const colSpan = extractSpan(attrs, 'colspan');
			row[colIndex] = {
				content: normalizeTableCellText(content),
				rowSpan,
				colSpan
			};
			for (let spanOffset = 1; spanOffset < colSpan; spanOffset++) {
				row[colIndex + spanOffset] = {
					content: ''
				};
			}
			if (rowSpan > 1) {
				for (let spanOffset = 0; spanOffset < colSpan; spanOffset++) {
					pendingRowSpans[colIndex + spanOffset] = Math.max(
						pendingRowSpans[colIndex + spanOffset] || 0,
						rowSpan - 1
					);
				}
			}
			colIndex += colSpan;
		}

		consumePendingSpans();
		return row;
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

function tryParseMarkdownTableAt(
	lines: string[],
	startIndex: number
): { lineCount: number; source: string; meta: Record<string, any> } | null {
	const headerLine = String(lines[startIndex] || '');
	const delimiterLine = String(lines[startIndex + 1] || '');
	if (!isMarkdownTableRow(headerLine) || !isMarkdownTableDelimiter(delimiterLine)) {
		return null;
	}

	const collected = [headerLine, delimiterLine];
	let cursor = startIndex + 2;
	while (cursor < lines.length && isMarkdownTableRow(String(lines[cursor] || ''))) {
		collected.push(String(lines[cursor] || ''));
		cursor += 1;
	}

	const rows = collected.map((rowLine) => splitMarkdownTableRow(rowLine));
	if (rows.length < 2) {
		return null;
	}

	const header = rows[0];
	const body = rows.slice(2);
	const columnSize = header.length;
	if (columnSize === 0) {
		return null;
	}

	const normalizedRows = [header, ...body].map((row) => {
		const normalizedRow = [];
		for (let col = 0; col < columnSize; col++) {
			normalizedRow.push({
				content: normalizeMarkdownTableCellText(row[col] || '')
			});
		}
		return normalizedRow;
	});

	return {
		lineCount: collected.length,
		source: collected.join('\n'),
		meta: {
			rowSize: normalizedRows.length,
			columnSize,
			rows: normalizedRows
		}
	};
}

function isMarkdownTableRow(line: string): boolean {
	const trimmed = String(line || '').trim();
	if (!trimmed || /^>/.test(trimmed)) {
		return false;
	}
	return /\|/.test(trimmed);
}

function isMarkdownTableDelimiter(line: string): boolean {
	const cells = splitMarkdownTableRow(line);
	if (cells.length === 0) {
		return false;
	}
	return cells.every((cell) => /^:?-{2,}:?$/.test(cell.trim()));
}

function splitMarkdownTableRow(line: string): string[] {
	const trimmed = String(line || '').trim();
	if (!trimmed.includes('|')) {
		return [];
	}

	let body = trimmed;
	if (body.startsWith('|')) {
		body = body.slice(1);
	}
	if (body.endsWith('|')) {
		body = body.slice(0, -1);
	}

	const cells: string[] = [];
	let current = '';
	let escaped = false;

	for (let index = 0; index < body.length; index++) {
		const char = body[index];
		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}
		if (char === '\\') {
			escaped = true;
			current += char;
			continue;
		}
		if (char === '|') {
			cells.push(current.trim());
			current = '';
			continue;
		}
		current += char;
	}

	cells.push(current.trim());
	return cells;
}

function normalizeMarkdownTableCellText(value: string): string {
	return normalizeTableCellText(
		String(value || '')
			.replace(/\\\|/g, '|')
			.replace(/\r\n?/g, '\n')
	);
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

function buildStructuredNodes(nodes: any[], descendants: any[]): string[] {
	const childIds: string[] = [];
	for (const node of nodes) {
		const insertIndex = descendants.length;
		const blockId = createGeneratedBlockId(node?.kind || 'node');
		const children = buildStructuredNodes(Array.isArray(node?.children) ? node.children : [], descendants);
		const block = buildStructuredNodeBlock(blockId, node, children);
		if (!block) {
			continue;
		}
		descendants.splice(insertIndex, 0, block);
		childIds.push(blockId);
	}
	return childIds;
}

function buildStructuredNodeBlock(blockId: string, node: any, children: string[]): any | null {
	const text = typeof node?.text === 'string' ? node.text : '';
	switch (node?.kind) {
		case 'paragraph':
			return {
				block_id: blockId,
				block_type: 2,
				text: {
					elements: buildRichTextElements(text)
				},
				children
			};
		case 'bullet':
			return {
				block_id: blockId,
				block_type: 12,
				bullet: {
					elements: buildRichTextElements(text),
					style: {
						align: 1,
						folded: false
					}
				},
				children
			};
		case 'ordered':
			return {
				block_id: blockId,
				block_type: 13,
				ordered: {
					elements: buildRichTextElements(text),
					style: {
						align: 1,
						folded: false,
						sequence: String(node?.sequence || 1)
					}
				},
				children
			};
		case 'todo':
			return {
				block_id: blockId,
				block_type: 17,
				todo: {
					checked: !!node?.checked,
					style: {
						align: 1,
						done: !!node?.checked,
						folded: false
					},
					elements: buildRichTextElements(text)
				},
				children
			};
		default:
			return null;
	}
}

function buildRichTextElements(markdown: string): any[] {
	const elements: any[] = [];
	const text = String(markdown || '');
	const colorMap: Record<string, number> = {
		gray: 1,
		brown: 2,
		orange: 3,
		yellow: 4,
		green: 5,
		blue: 6,
		purple: 7
	};
	const tokenRegex = /<u>([\s\S]*?)<\/u>|<mark>([\s\S]*?)<\/mark>|<span\s+style=["'][^"']*color\s*:\s*(gray|brown|orange|yellow|green|blue|purple)[^"']*["']\s*>([\s\S]*?)<\/span>|==([\s\S]+?)==|\*\*([\s\S]+?)\*\*|(?<!\*)\*([^*\n]+?)\*(?!\*)|`([^`\n]+?)`|~~([\s\S]+?)~~|(?<!\$)\$([^\n$]+?)\$(?!\$)/gi;
	let lastIndex = 0;
	let match: RegExpExecArray | null;

	while ((match = tokenRegex.exec(text)) !== null) {
		if (match.index > lastIndex) {
			elements.push({
				text_run: {
					content: text.slice(lastIndex, match.index)
				}
			});
		}

		if (match[1] !== undefined) {
			elements.push({ text_run: { content: match[1], text_element_style: { underline: true } } });
		} else if (match[2] !== undefined) {
			elements.push({ text_run: { content: match[2], text_element_style: { background_color: 3 } } });
		} else if (match[4] !== undefined) {
			elements.push({
				text_run: {
					content: match[4],
					text_element_style: { text_color: colorMap[String(match[3] || '').toLowerCase()] || 0 }
				}
			});
		} else if (match[5] !== undefined) {
			elements.push({ text_run: { content: match[5], text_element_style: { background_color: 3 } } });
		} else if (match[6] !== undefined) {
			elements.push({ text_run: { content: match[6], text_element_style: { bold: true } } });
		} else if (match[7] !== undefined) {
			elements.push({ text_run: { content: match[7], text_element_style: { italic: true } } });
		} else if (match[8] !== undefined) {
			elements.push({ text_run: { content: match[8], text_element_style: { inline_code: true } } });
		} else if (match[9] !== undefined) {
			elements.push({ text_run: { content: match[9], text_element_style: { strikethrough: true } } });
		} else if (match[10] !== undefined) {
			elements.push({ equation: { content: normalizeEquationContent(match[10]) } });
		}

		lastIndex = tokenRegex.lastIndex;
	}

	if (lastIndex < text.length) {
		elements.push({
			text_run: {
				content: text.slice(lastIndex)
			}
		});
	}

	const filtered = elements.filter((element) => {
		if (element?.text_run) {
			return typeof element.text_run.content === 'string' && element.text_run.content.length > 0;
		}
		if (element?.equation) {
			return typeof element.equation.content === 'string' && element.equation.content.length > 0;
		}
		return false;
	});

	return filtered.length > 0
		? filtered
		: [{ text_run: { content: '' } }];
}

function normalizeEquationContent(formula: string): string {
	return String(formula || '')
		.replace(/\r\n?/g, '\n')
		.replace(/^\n+|\n+$/g, '')
		.replace(/\\\\(?=[A-Za-z])/g, '\\')
		.replace(/\\\\,/g, '\\,');
}

function tryParseQuoteSection(
	lines: string[],
	startIndex: number
): { lineCount: number; source: string; meta: Record<string, any> } | null {
	const firstLine = String(lines[startIndex] || '');
	if (!isQuoteLine(firstLine) || isCalloutQuoteLine(firstLine)) {
		return null;
	}

	const collected: string[] = [];
	let cursor = startIndex;
	while (cursor < lines.length) {
		const line = String(lines[cursor] || '');
		if (line.trim() === '') {
			if (cursor + 1 < lines.length && isQuoteLine(String(lines[cursor + 1] || ''))) {
				collected.push(line);
				cursor += 1;
				continue;
			}
			break;
		}
		if (!isQuoteLine(line) || isCalloutQuoteLine(line)) {
			break;
		}
		collected.push(line);
		cursor += 1;
	}

	if (collected.length === 0) {
		return null;
	}

	const strippedLines = collected.map(stripSingleQuotePrefix);
	const parsed = parseStructuredNodes(strippedLines, true);
	if (!parsed) {
		return null;
	}

	return {
		lineCount: collected.length,
		source: collected.join('\n'),
		meta: parsed
	};
}

function tryParseListSection(
	lines: string[],
	startIndex: number
): { lineCount: number; source: string; meta: Record<string, any> } | null {
	const firstLine = String(lines[startIndex] || '');
	if (!isListLine(firstLine)) {
		return null;
	}

	const collected: string[] = [];
	let cursor = startIndex;
	while (cursor < lines.length) {
		const line = String(lines[cursor] || '');
		if (line.trim() === '') {
			if (cursor + 1 < lines.length) {
				const nextLine = String(lines[cursor + 1] || '');
				if (isListLine(nextLine) || isIndentedContinuationLine(nextLine)) {
					collected.push(line);
					cursor += 1;
					continue;
				}
			}
			break;
		}
		if (!isListLine(line) && !isIndentedContinuationLine(line)) {
			break;
		}
		collected.push(line);
		cursor += 1;
	}

	if (collected.length === 0) {
		return null;
	}

	const parsed = parseStructuredNodes(collected, false);
	if (!parsed || parsed.kind !== 'list' || !Array.isArray(parsed.nodes) || parsed.nodes.length === 0) {
		return null;
	}

	return {
		lineCount: collected.length,
		source: collected.join('\n'),
		meta: parsed
	};
}

function parseStructuredNodes(lines: string[], allowParagraphs: boolean): Record<string, any> | null {
	const root = { indent: -1, children: [] as any[] };
	const stack = [root];
	let lastNode: any | null = null;

	for (const rawLine of lines) {
		const line = String(rawLine || '').replace(/\r/g, '');
		if (line.trim() === '') {
			if (lastNode?.kind === 'paragraph' && !lastNode.text.endsWith('\n')) {
				lastNode.text += '\n';
			}
			continue;
		}

		const listMatch = parseListLine(line);
		if (listMatch) {
			while (stack.length > 1 && listMatch.indent <= stack[stack.length - 1].indent) {
				stack.pop();
			}
			const node = {
				kind: listMatch.kind,
				text: listMatch.text,
				checked: listMatch.checked,
				sequence: listMatch.sequence,
				indent: listMatch.indent,
				children: [] as any[]
			};
			stack[stack.length - 1].children.push(node);
			stack.push(node);
			lastNode = node;
			continue;
		}

		const rawIndent = countLeadingSpaces(line);
		const text = line.trim();
		const parent = findContinuationParent(stack, rawIndent, allowParagraphs);
		if (!parent) {
			continue;
		}

		const previousChild = parent.children[parent.children.length - 1];
		if (previousChild?.kind === 'paragraph') {
			previousChild.text = `${String(previousChild.text || '').replace(/\n$/, '')}\n${text}`;
			lastNode = previousChild;
			continue;
		}

		const paragraphNode = {
			kind: 'paragraph',
			text,
			indent: rawIndent,
			children: [] as any[]
		};
		parent.children.push(paragraphNode);
		lastNode = paragraphNode;
	}

	if (allowParagraphs) {
		const nodes = root.children.slice();
		if (nodes.length === 0) {
			return null;
		}
		const firstNode = nodes[0];
		if (firstNode.kind === 'paragraph') {
			return {
				kind: 'quote',
				quoteText: firstNode.text,
				nodes: nodes.slice(1)
			};
		}
		return {
			kind: 'quote',
			quoteText: '',
			nodes
		};
	}

	return root.children.length > 0
		? {
			kind: 'list',
			nodes: root.children
		}
		: null;
}

function findContinuationParent(stack: Array<{ indent: number; children: any[] }>, rawIndent: number, allowParagraphs: boolean): { indent: number; children: any[] } | null {
	for (let index = stack.length - 1; index >= 1; index--) {
		if (rawIndent > stack[index].indent) {
			return stack[index];
		}
	}
	return allowParagraphs ? stack[0] : stack[stack.length - 1] || null;
}

function parseListLine(line: string): { indent: number; kind: 'bullet' | 'ordered' | 'todo'; text: string; checked?: boolean; sequence?: number } | null {
	const match = String(line || '').match(/^([ \t]*)([-*+]|\d+\.)\s(?:\[( |x|X)\]\s+)?(.+)$/);
	if (!match) {
		return null;
	}

	const indent = countLeadingSpaces(match[1] || '');
	const marker = String(match[2] || '');
	const todoState = match[3];
	const text = String(match[4] || '').trim();

	if (todoState !== undefined) {
		return {
			indent,
			kind: 'todo',
			text,
			checked: String(todoState || '').toLowerCase() === 'x'
		};
	}

	if (/^\d+\.$/.test(marker)) {
		return {
			indent,
			kind: 'ordered',
			text,
			sequence: Number(marker.slice(0, -1)) || 1
		};
	}

	return {
		indent,
		kind: 'bullet',
		text
	};
}

function isListLine(line: string): boolean {
	return /^([ \t]*)([-*+]|\d+\.)\s(?:\[(?: |x|X)\]\s+)?\S/.test(String(line || ''));
}

function isIndentedContinuationLine(line: string): boolean {
	const text = String(line || '');
	if (!text.trim()) {
		return false;
	}
	if (isQuoteLine(text) || isListLine(text)) {
		return false;
	}
	return countLeadingSpaces(text) > 0;
}

function isQuoteLine(line: string): boolean {
	return /^[ \t]*>/.test(String(line || ''));
}

function isCalloutQuoteLine(line: string): boolean {
	return /^[ \t]*>\s*\[![^\]]+\]/.test(String(line || ''));
}

function stripSingleQuotePrefix(line: string): string {
	return String(line || '').replace(/^[ \t]*>\s?/, '');
}

function countLeadingSpaces(value: string): number {
	return String(value || '').replace(/\t/g, '    ').match(/^\s*/)?.[0].length || 0;
}
