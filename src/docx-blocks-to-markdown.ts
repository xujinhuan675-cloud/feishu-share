
import type { App, TFile } from 'obsidian';

type DocxBlocksToMarkdownOptions = {
	app?: App;
};

export class DocxBlocksToMarkdown {
	static convert(blocks: any[], options?: DocxBlocksToMarkdownOptions): string {
		if (!Array.isArray(blocks) || blocks.length === 0) {
			return '';
		}

		const fileIndex = this.buildVaultMarkdownIndex(options?.app);

		const idToBlock = new Map<string, any>();
		for (const b of blocks) {
			if (b && b.block_id) {
				idToBlock.set(String(b.block_id), b);
			}
		}

		const normalizeFileKey = (s: string): string => {
			return String(s || '')
				.trim()
				.replace(/\.(md|markdown)$/i, '')
				.toLowerCase()
				.replace(/\s+/g, '');
		};

		const extractTextFromRichText = (rich: any): string => {
			const textColorMap: Record<number, string> = {
				1: 'gray',
				2: 'brown',
				3: 'orange',
				4: 'yellow',
				5: 'green',
				6: 'blue',
				7: 'purple'
			};
			const elements: any[] = rich && Array.isArray(rich.elements) ? rich.elements : [];
			if (!Array.isArray(elements) || elements.length === 0) {
				return '';
			}
			const parts: string[] = [];
			for (const el of elements) {
				if (el && el.text_run && typeof el.text_run.content === 'string') {
					let content: string = el.text_run.content;
					const style = el.text_run.text_element_style || el.text_run.text_style || {};
					const prefix: string[] = [];
					const suffix: string[] = [];

					if (style.link && style.link.url) {
						content = `[${content}](${style.link.url})`;
					}

					if (style.inline_code || style.code) {
						prefix.unshift('`');
						suffix.push('`');
					} else {
						if (style.bold) {
							prefix.push('**');
							suffix.unshift('**');
						}
						if (style.italic) {
							prefix.push('_');
							suffix.unshift('_');
						}
						if (style.strikethrough) {
							prefix.push('~~');
							suffix.unshift('~~');
						}
						if (style.underline) {
							prefix.push('<u>');
							suffix.unshift('</u>');
						}
						const textColor = Number(style.text_color || style.textColor || 0);
						if (textColorMap[textColor]) {
							prefix.push(`<span style="color:${textColorMap[textColor]}">`);
							suffix.unshift('</span>');
						}
						if (style.background_color || style.backgroundColor) {
							prefix.push('==');
							suffix.unshift('==');
						}
					}

					const raw = String(content);
					const ws = `[\\s\\u200B\\u200C\\u200D\\uFEFF]`;
					const m = raw.match(new RegExp(`^(${ws}*)([\\s\\S]*?)(${ws}*)$`));
					const leadingWs = m ? m[1] : '';
					const core = m ? m[2] : raw;
					const trailingWs = m ? m[3] : '';
					const hasWrapper = prefix.length > 0 || suffix.length > 0;
					const isOnlyBold = !!style.bold
						&& !style.italic
						&& !style.strikethrough
						&& !style.underline
						&& !(style.inline_code || style.code)
						&& !(style.background_color || style.backgroundColor)
						&& !(style.link && style.link.url);
					const coreTrimmed = String(core || '').replace(/[\u200B\u200C\u200D\uFEFF]+$/g, '');
					const boldColonSafe = isOnlyBold && coreTrimmed && /[:：]$/.test(coreTrimmed);
					const wrapped = (() => {
						if (hasWrapper && core) {
							if (boldColonSafe) {
								return `<strong>${coreTrimmed}</strong>`;
							}
							return prefix.join('') + core + suffix.join('');
						}
						return prefix.join('') + raw + suffix.join('');
					})();
					let segment = hasWrapper && core ? (leadingWs + wrapped + trailingWs) : wrapped;
					const last = parts.length > 0 ? parts[parts.length - 1] : '';
					const mergeTokens = ['**', '==', '~~', '_'];
					for (const token of mergeTokens) {
						if (last.endsWith(token) && segment.startsWith(token)) {
							parts[parts.length - 1] = last.slice(0, -token.length);
							segment = segment.slice(token.length);
							break;
						}
					}
					parts.push(segment);
					continue;
				}

				if (el && el.equation && typeof el.equation.content === 'string') {
					const eq = el.equation.content.replace(/\n+$/, '');
					parts.push(`$${eq}$`);
					continue;
				}

				if (el && el.mention_doc) {
					const title = typeof el.mention_doc.title === 'string' ? el.mention_doc.title : '文档';
					const url = typeof el.mention_doc.url === 'string' ? el.mention_doc.url : '';
					const key = normalizeFileKey(title);
					const local = key ? fileIndex.get(key) : null;
					if (local) {
						parts.push(`[[${local}]]`);
						continue;
					}
					if (url) {
						parts.push(`[${title}](${url})`);
					} else {
						parts.push(title);
					}
					continue;
				}

				if (el && el.mention_user) {
					const userId = el.mention_user.user_id || el.mention_user.id || '';
					parts.push(userId ? String(userId) : '');
					continue;
				}

				parts.push('');
			}
			return parts.join('');
		};

		const extractTextFromField = (field: any): string => {
			if (!field) return '';
			if (Array.isArray(field)) {
				return extractTextFromRichText({ elements: field });
			}
			if (field.elements) {
				return extractTextFromRichText(field);
			}
			if (field.rich_text) {
				return extractTextFromRichText({ elements: field.rich_text });
			}
			return '';
		};

		const getBlockText = (block: any): string => {
			if (!block) return '';
			const fields = [
				block.heading1, block.heading2, block.heading3, block.heading4, block.heading5,
				block.heading6, block.heading7, block.heading8, block.heading9,
				block.heading, block.paragraph, block.text, block.quote, block.quote_container,
				block.ordered, block.bullet, block.todo, block.code,
				block.title, block.rich_text
			];
			for (const f of fields) {
				const t = extractTextFromField(f);
				if (t) return t;
			}
			return '';
		};

		const convertTableToHtml = (tableBlock: any, indent: number): string => {
			const t = tableBlock && tableBlock.table ? tableBlock.table : null;
			if (!t) return '';

			const space = indent > 0 ? '    '.repeat(indent) : '';
			const brReplacer = (text: string) => String(text || '').replace(/\n+/g, '<br/>');

			const columnSize = t.property && typeof t.property.column_size === 'number' ? t.property.column_size : 0;
			const cells = Array.isArray(t.cells) ? t.cells : [];
			if (!columnSize || cells.length === 0) {
				return '';
			}

			const rows: string[][] = [];
			for (let i = 0; i < cells.length; i++) {
				const rowIndex = Math.floor(i / columnSize);
				const colIndex = i % columnSize;
				const cellRef = cells[i];
				let cellContent = '';
				const cellBlockId = cellRef != null ? String(cellRef) : '';
				const cellBlock = cellBlockId ? idToBlock.get(cellBlockId) : null;
				if (cellBlock) {
					if (Number(cellBlock.block_type) === 32 && Array.isArray(cellBlock.children)) {
						const childContents: string[] = [];
						for (const childId of cellBlock.children) {
							const rendered = render(String(childId), 0, false, true);
							if (rendered) childContents.push(brReplacer(rendered));
						}
						cellContent = childContents.join('<br/>');
					} else {
						const rendered = render(cellBlockId, 0, false, true);
						cellContent = rendered ? brReplacer(rendered) : '';
					}
				}
				if (!rows[rowIndex]) rows[rowIndex] = [];
				rows[rowIndex][colIndex] = cellContent;
			}

			const mergeInfoMap: Record<string, any> = {};
			if (t.property && Array.isArray(t.property.merge_info)) {
				for (let i = 0; i < t.property.merge_info.length; i++) {
					const rowIndex = Math.floor(i / columnSize);
					const colIndex = i % columnSize;
					mergeInfoMap[`${rowIndex}-${colIndex}`] = t.property.merge_info[i];
				}
			}

			const processed: Record<string, boolean> = {};
			const html: string[] = [];
			html.push(`${space}<table>`);
			for (let r = 0; r < rows.length; r++) {
				html.push(`${space}<tr>`);
				const row = rows[r] || [];
				for (let c = 0; c < row.length; c++) {
					const key = `${r}-${c}`;
					if (processed[key]) continue;
					const mergeInfo = mergeInfoMap[key];
					const content = row[c] || '';
					if (mergeInfo && ((mergeInfo.row_span && mergeInfo.row_span > 1) || (mergeInfo.col_span && mergeInfo.col_span > 1))) {
						const attrs: string[] = [];
						if (mergeInfo.row_span && mergeInfo.row_span > 1) attrs.push(`rowspan="${mergeInfo.row_span}"`);
						if (mergeInfo.col_span && mergeInfo.col_span > 1) attrs.push(`colspan="${mergeInfo.col_span}"`);
						html.push(`${space}<td${attrs.length ? ' ' + attrs.join(' ') : ''}>${content}</td>`);
						const rs = mergeInfo.row_span || 1;
						const cs = mergeInfo.col_span || 1;
						for (let rr = r; rr < r + rs; rr++) {
							for (let cc = c; cc < c + cs; cc++) {
								processed[`${rr}-${cc}`] = true;
							}
						}
					} else {
						html.push(`${space}<td>${content}</td>`);
						processed[key] = true;
					}
				}
				html.push(`${space}</tr>`);
			}
			html.push(`${space}</table>`);
			return html.join('\n');
		};

		const isMermaidLike = (s: string): boolean => {
			const t = String(s || '').trim();
			if (!t) return false;
			return /^(flowchart|sequenceDiagram|classDiagram|erDiagram|stateDiagram|gantt|pie)\b/.test(t);
		};

		const render = (blockId: string, indent: number, inQuote: boolean = false, inContainer: boolean = false): string => {
			const block = idToBlock.get(blockId);
			if (!block) return '';

			const children: string[] = Array.isArray(block.children) ? block.children.map((x: any) => String(x)) : [];
			const type = Number(block.block_type);

			const space = indent > 0 ? '    '.repeat(indent) : '';
			const content = getBlockText(block).trimEnd();

			const renderChildren = (nextIndent: number, nextInQuote: boolean, nextInContainer: boolean): string => {
				const parts: string[] = [];
				for (const cid of children) {
					const r = render(cid, nextIndent, nextInQuote, nextInContainer);
					if (r) parts.push(r);
				}
				return parts.join('\n');
			};

			if (type === 1) {
				return renderChildren(indent, inQuote, inContainer);
			}

			if (type === 2) {
				const line = content ? `${space}${content}` : '';
				const child = renderChildren(indent, inQuote, inContainer);
				return [line, child].filter(Boolean).join('\n');
			}

			if (type >= 3 && type <= 11) {
				const level = type - 2;
				const prefix = '#'.repeat(Math.max(1, Math.min(6, level)));
				const line = content
					? (inContainer ? `${space}**${content}**` : `${space}${prefix} ${content}`)
					: '';
				const child = renderChildren(indent, inQuote, inContainer);
				return [line, child].filter(Boolean).join('\n');
			}

			if (type === 12) {
				const line = `${space}- ${content}`.trimEnd();
				const child = renderChildren(indent + 1, inQuote, inContainer);
				return [line, child].filter(Boolean).join('\n');
			}

			if (type === 13) {
				const line = `${space}1. ${content}`.trimEnd();
				const child = renderChildren(indent + 1, inQuote, inContainer);
				return [line, child].filter(Boolean).join('\n');
			}

			if (type === 14 || type === 16) {
				const lang = block.code && block.code.style && typeof block.code.style.language === 'string' ? block.code.style.language : '';
				const line = `${space}\`\`\`${lang || ''}`.trimEnd();
				const body = `${space}${getBlockText(block)}`.trimEnd();
				const end = `${space}\`\`\``;
				return [line, body, end].join('\n');
			}

			if (type === 15) {
				const line = content ? `${space}> ${content}` : `${space}>`;
				const childText = renderChildren(indent, true, inContainer);
				if (!childText) return line;
				const quoted = childText
					.split('\n')
					.map((l) => (l ? `${space}> ${l}` : `${space}>`))
					.join('\n');
				return [line, quoted].join('\n');
			}

			if (type === 31 && block.table) {
				const html = convertTableToHtml(block, indent);
				if (html) return html;
				const line = content ? `${space}${content}` : '';
				const child = renderChildren(indent, inQuote, true);
				return [line, child].filter(Boolean).join('\n');
			}

			if (type === 32) {
				// table_cell 由 table 渲染
				const child = renderChildren(indent, inQuote, true);
				return child;
			}

			if (type === 22) {
				return `${space}---`;
			}

			if (type === 27) {
				const token = block.image && block.image.token ? String(block.image.token) : '';
				return token ? `${space}![](${token})` : '';
			}

			if (type === 18) {
				const token = block.bitable && block.bitable.token ? String(block.bitable.token) : '';
				return token ? `${space}[Bitable](${token})` : `${space}[Bitable]`;
			}

			if (type === 20) {
				const chatId = block.chat_card && block.chat_card.chat_id ? String(block.chat_card.chat_id) : '';
				return chatId ? `${space}[ChatCard](${chatId})` : `${space}[ChatCard]`;
			}

			if (type === 21) {
				const diagram = block.diagram || {};
				const diagramType = diagram.diagram_type ? String(diagram.diagram_type) : '';
				let mermaidSource = '';
				const rawCandidates: any[] = [diagram.content, diagram.data, diagram.diagram_data];
				for (const cand of rawCandidates) {
					if (typeof cand === 'string') {
						const s = cand.trim();
						if (!s) continue;
						if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
							try {
								const parsed: any = JSON.parse(s);
								const maybe = parsed && typeof parsed.mermaid === 'string' ? parsed.mermaid : (parsed && typeof parsed.content === 'string' ? parsed.content : '');
								if (maybe && String(maybe).trim()) {
									mermaidSource = String(maybe).trim();
									break;
								}
							} catch {
								// ignore
							}
						}
						mermaidSource = s;
						break;
					}
					if (cand && typeof cand === 'object') {
						const maybe = typeof cand.mermaid === 'string' ? cand.mermaid : (typeof cand.content === 'string' ? cand.content : '');
						if (maybe && String(maybe).trim()) {
							mermaidSource = String(maybe).trim();
							break;
						}
					}
				}
				if (mermaidSource) {
					const lines = mermaidSource.split('\n');
					return [
						`${space}\`\`\`mermaid`,
						...lines.map((l) => `${space}${l}`),
						`${space}\`\`\``
					].join('\n');
				}
				const fallback = diagramType ? `[Diagram:${diagramType}]` : '[Diagram]';
				return `${space}${fallback}`;
			}

			if (type === 23) {
				const name = block.file && block.file.name ? String(block.file.name) : '附件';
				const token = block.file && block.file.token ? String(block.file.token) : '';
				return token ? `${space}[${name}](${token})` : `${space}[${name}]`;
			}

			if (type === 24) {
				const child = renderChildren(indent, inQuote, inContainer);
				return child;
			}

			if (type === 25) {
				return '';
			}

			if (type === 26) {
				const url = block.iframe && block.iframe.component && block.iframe.component.url ? String(block.iframe.component.url) : '';
				return url ? `${space}[Iframe](${url})` : `${space}[Iframe]`;
			}

			if (type === 28) {
				const cid = block.isv && block.isv.component_id ? String(block.isv.component_id) : '';
				const ctid = block.isv && block.isv.component_type_id ? String(block.isv.component_type_id) : '';
				const text = [cid, ctid].filter(Boolean).join('/');
				return text ? `${space}[ISV:${text}]` : `${space}[ISV]`;
			}

			if (type === 29) {
				const token = block.mindnote && block.mindnote.token ? String(block.mindnote.token) : '';
				return token ? `${space}[Mindnote](${token})` : `${space}[Mindnote]`;
			}

			if (type === 30) {
				const token = block.sheet && block.sheet.token ? String(block.sheet.token) : '';
				return token ? `${space}[Sheet](${token})` : `${space}[Sheet]`;
			}

			if (type === 40) {
				const addOns = block.add_ons || {};
				const componentTypeId = addOns && typeof addOns.component_type_id === 'string' ? addOns.component_type_id : '';
				const recordStr = addOns && typeof addOns.record === 'string' ? addOns.record : '';
				if (recordStr) {
					try {
						const obj: any = JSON.parse(recordStr);
						const data = obj && typeof obj.data === 'string' ? obj.data : '';
						if (data && (isMermaidLike(data) || obj.view === 'chart')) {
							const mermaidSource = String(data).replace(/\n+$/, '');
							const lines = mermaidSource.split('\n');
							return [
								`${space}\`\`\`mermaid`,
								...lines.map((l) => `${space}${l}`),
								`${space}\`\`\``
							].join('\n');
						}
					} catch {
						// ignore
					}
				}
				const fallback = componentTypeId ? `[Widget:${componentTypeId}]` : '[Widget]';
				const line = content ? `${space}${fallback} ${content}` : `${space}${fallback}`;
				const child = renderChildren(indent, inQuote, inContainer);
				return [line, child].filter(Boolean).join('\n');
			}

			if (type === 41) {
				const line = content ? `${space}[Jira] ${content}` : `${space}[Jira]`;
				const child = renderChildren(indent, inQuote, inContainer);
				return [line, child].filter(Boolean).join('\n');
			}

			if (type === 43) {
				const token = block.board && block.board.token ? String(block.board.token) : '';
				return token ? `${space}[Whiteboard:${token}]` : `${space}[Whiteboard]`;
			}

			if (type === 34 || block.quote_container) {
				const head = content ? `${space}> ${content}` : `${space}>`;
				const childText = renderChildren(indent, true, inContainer);
				if (!childText) return head;
				const quoted = childText
					.split('\n')
					.map((l) => (l ? `${space}> ${l}` : `${space}>`))
					.join('\n');
				return [head, quoted].join('\n');
			}

			if (type === 17) {
				const checked = !!(block.todo && (block.todo.checked || block.todo.is_checked || (block.todo.style && block.todo.style.done)));
				const line = `${space}- [${checked ? 'x' : ' '}] ${content}`.trimEnd();
				const child = renderChildren(indent + 1, inQuote, inContainer);
				return [line, child].filter(Boolean).join('\n');
			}

			const line = content ? `${space}${content}` : '';
			const child = renderChildren(indent, inQuote, inContainer);
			return [line, child].filter(Boolean).join('\n');
		};

		const roots = blocks.filter((b: any) => b && Number(b.block_type) === 1);
		const root = roots.length > 0 ? roots[0] : blocks[0];
		const rootId = root && root.block_id ? String(root.block_id) : '';
		const md = rootId ? render(rootId, 0, false, false) : '';
		return String(md || '').replace(/\n{3,}/g, '\n\n').trim() + '\n';
	}

	private static buildVaultMarkdownIndex(app?: App): Map<string, string> {
		const map = new Map<string, string>();
		try {
			if (!app) {
				return map;
			}
			const files: TFile[] = app.vault.getMarkdownFiles();
			for (const f of files) {
				const p = String(f.path || '');
				const base = (p.split('/').pop() || p.split('\\').pop() || '').replace(/\.(md|markdown)$/i, '');
				const key = String(base).trim().toLowerCase().replace(/\s+/g, '');
				if (!key) continue;
				map.set(key, p.replace(/\.(md|markdown)$/i, ''));
			}
			return map;
		} catch {
			return map;
		}
	}
}
