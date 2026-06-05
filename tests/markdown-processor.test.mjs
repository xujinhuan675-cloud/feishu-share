import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Buffer } from 'node:buffer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function loadModule() {
	const result = await build({
		entryPoints: [path.join(rootDir, 'src', 'markdown-processor.ts')],
		bundle: true,
		format: 'esm',
		platform: 'node',
		write: false,
		external: ['obsidian']
	});
	const obsidianStub = `
		export function normalizePath(input) {
			return String(input || '').replace(/\\\\/g, '/');
		}
		export class TFile {}
		export class App {}
	`;
	const obsidianStubUrl = `data:text/javascript;base64,${Buffer.from(obsidianStub).toString('base64')}`;
	const source = result.outputFiles[0].text.replace(/from "obsidian"/g, `from "${obsidianStubUrl}"`);
	const url = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
	return import(url);
}

const { MarkdownProcessor } = await loadModule();

const appStub = {
	vault: {
		getFileByPath() { return null; },
		getMarkdownFiles() { return []; },
		getFiles() { return []; }
	}
};

test('markdown processor extracts inline doc tokens for underline color and equations', () => {
	const processor = new MarkdownProcessor(appStub);
	const result = processor.processCompleteWithFiles([
		'Normal <u>under</u> text',
		'Color <span style="color:blue">blue</span>',
		'Highlight ==glow==',
		'Inline $a+b$ and block:',
		'$$',
		'c=d',
		'$$'
	].join('\n'));

	assert.equal(Array.isArray(result.inlineDocTokens), true);
	assert.equal(result.inlineDocTokens.length, 5);
	assert.ok(result.inlineDocTokens.some((item) => item.kind === 'text' && item.style?.underline));
	assert.ok(result.inlineDocTokens.some((item) => item.kind === 'text' && item.style?.text_color === 6));
	assert.ok(result.inlineDocTokens.some((item) => item.kind === 'text' && item.style?.background_color === 3 && item.content === 'glow'));
	assert.ok(result.inlineDocTokens.some((item) => item.kind === 'equation' && item.content === 'a+b' && item.displayMode === 'inline'));
	assert.ok(result.inlineDocTokens.some((item) => item.kind === 'equation' && item.content === 'c=d' && item.displayMode === 'block'));
	assert.ok(!result.content.includes('<u>under</u>'));
	assert.ok(!result.content.includes('<span style="color:blue">blue</span>'));
	assert.ok(!result.content.includes('$$'));
});

test('markdown processor converts nested list sections into generated list structures', () => {
	const processor = new MarkdownProcessor(appStub);
	const result = processor.processCompleteWithFiles([
		'- 无序列表 1',
		'- 无序列表 2',
		'    - 二级无序列表',
		'    - 二级无序列表里的 **粗体**',
		'- [ ] 未完成任务',
		'  - [x] 已完成子任务'
	].join('\n'));

	const lists = result.localFiles.filter((item) => item.generatedType === 'list');
	assert.equal(lists.length, 1);
	assert.equal(lists[0].generatedMeta.kind, 'list');
	assert.equal(lists[0].generatedMeta.nodes[1].children.length, 2);
	assert.equal(lists[0].generatedMeta.nodes[2].kind, 'todo');
	assert.equal(lists[0].generatedMeta.nodes[2].children[0].kind, 'todo');
	assert.ok(!result.content.includes('- [ ]'));
	assert.ok(!result.content.includes('二级无序列表'));
});

test('markdown processor keeps quoted list sections as generated quote structures', () => {
	const processor = new MarkdownProcessor(appStub);
	const result = processor.processCompleteWithFiles([
		'> 第一层引用',
		'> - 引用中的列表 1',
		'> - [ ] quoted open task',
		'>   - [x] quoted done task',
		'> 引用结束段落'
	].join('\n'));

	const lists = result.localFiles.filter((item) => item.generatedType === 'list');
	assert.equal(lists.length, 1);
	assert.equal(lists[0].generatedMeta.kind, 'quote');
	assert.equal(lists[0].generatedMeta.quoteText, '第一层引用');
	assert.equal(lists[0].generatedMeta.nodes[1].kind, 'todo');
	assert.equal(lists[0].generatedMeta.nodes[1].children[0].kind, 'todo');
	assert.equal(lists[0].generatedMeta.nodes[2].kind, 'paragraph');
	assert.ok(!result.content.includes('- [ ]'));
	assert.ok(!result.content.includes('quoted open task'));
});

test('markdown processor extracts html tables into generated doc blocks', () => {
	const processor = new MarkdownProcessor(appStub);
	const result = processor.processCompleteWithFiles([
		'<table>',
		'<tr><td>A</td><td>B</td></tr>',
		'</table>'
	].join('\n'));

	assert.equal(result.localFiles.some((item) => item.generatedType === 'table'), true);
	assert.doesNotMatch(result.content, /<table>/);
});

test('markdown processor extracts markdown pipe tables into generated doc blocks', () => {
	const processor = new MarkdownProcessor(appStub);
	const result = processor.processCompleteWithFiles([
		'| 列1 | 列2 | 列3 |',
		'| --- | --- | --- |',
		'| 文本 | **粗体** | `code` |',
		'| 蓝色 | 颜色文本 | 第三列 |'
	].join('\n'));

	const tables = result.localFiles.filter((item) => item.generatedType === 'table');
	assert.equal(tables.length, 1);
	assert.equal(tables[0].generatedMeta.rowSize, 3);
	assert.equal(tables[0].generatedMeta.columnSize, 3);
	assert.doesNotMatch(result.content, /\|\s*列1\s*\|/);
});

test('markdown processor keeps placeholder order consistent across list and table extraction stages', () => {
	const processor = new MarkdownProcessor(appStub);
	const result = processor.processCompleteWithFiles([
		'- 无序列表 1',
		'- 无序列表 2',
		'  - 二级无序列表',
		'',
		'| 左对齐 | 居中 | 右对齐 |',
		'| :---- | :--: | ----: |',
		'| alpha | beta | gamma |',
		'',
		'1. 一级有序列表',
		'   - 二级无序列表 A'
	].join('\n'));

	assert.deepEqual(
		result.localFiles.map((item) => item.generatedType),
		['list', 'table', 'list']
	);
});

test('markdown processor normalizes doubled latex command slashes in equations', () => {
	const processor = new MarkdownProcessor(appStub);
	const result = processor.processCompleteWithFiles('$$\n\\\\int_0^1 x^2 \\\\, dx = \\\\frac{1}{3}\n$$');
	const blockEquation = result.inlineDocTokens.find((item) => item.kind === 'equation' && item.displayMode === 'block');
	assert.equal(blockEquation.content, '\\int_0^1 x^2 \\, dx = \\frac{1}{3}');
});
