import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Buffer } from 'node:buffer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function loadModule() {
	const result = await build({
		entryPoints: [path.join(rootDir, 'src', 'feishu-doc-blocks.ts')],
		bundle: true,
		format: 'esm',
		platform: 'node',
		write: false
	});
	const source = result.outputFiles[0].text;
	const url = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
	return import(url);
}

const {
	buildGeneratedDocBlock,
	collectTableMergeRanges,
	extractGeneratedDocBlocks,
	extractGeneratedListStructures,
	FEISHU_MERMAID_COMPONENT_TYPE_ID
} = await loadModule();

test('extractGeneratedDocBlocks captures mermaid fences as placeholders', () => {
	let index = 0;
	const result = extractGeneratedDocBlocks([
		'# Demo',
		'',
		'    ```mermaid',
		'    flowchart TD',
		'      A --> B',
		'    ```',
		'',
		'After'
	].join('\n'), () => `__TEST_${++index}__`);

	assert.equal(result.localFiles.length, 1);
	assert.equal(result.localFiles[0].generatedType, 'mermaid');
	assert.equal(result.localFiles[0].generatedSource, 'flowchart TD\n  A --> B');
	assert.match(result.content, /__TEST_1__/);
	assert.ok(!result.content.includes('```mermaid'));
});

test('buildGeneratedDocBlock returns native Feishu mermaid block payload', () => {
	const result = buildGeneratedDocBlock({
		generatedType: 'mermaid',
		generatedSource: '\nflowchart TD\nA-->B\n\n'
	});

	assert.equal(result.kind, 'block');
	const block = result.block;
	assert.equal(block.block_type, 40);
	assert.equal(block.add_ons.component_type_id, FEISHU_MERMAID_COMPONENT_TYPE_ID);
	assert.deepEqual(JSON.parse(block.add_ons.record), {
		data: 'flowchart TD\nA-->B'
	});
});

test('buildGeneratedDocBlock returns native Feishu todo block payload', () => {
	const result = buildGeneratedDocBlock({
		generatedType: 'todo',
		generatedSource: 'ship feature',
		generatedMeta: { checked: true }
	});

	assert.equal(result.kind, 'block');
	assert.equal(result.block.block_type, 17);
	assert.equal(result.block.todo.checked, true);
	assert.equal(result.block.todo.elements[0].text_run.content, 'ship feature');
	assert.equal(result.block.todo.style.done, true);
});

test('extractGeneratedDocBlocks captures whiteboard placeholders and html tables', () => {
	let index = 0;
	const result = extractGeneratedDocBlocks([
		'[Whiteboard:wb_token_123]',
		'',
		'<table>',
		'<tr><td>Alpha</td><td>Beta</td></tr>',
		'<tr><td colspan="2">Merged</td></tr>',
		'</table>'
	].join('\n'), () => `__TEST_${++index}__`);

	assert.equal(result.localFiles.length, 2);
	assert.equal(result.localFiles[0].generatedType, 'whiteboard');
	assert.equal(result.localFiles[0].generatedMeta.token, 'wb_token_123');
	assert.equal(result.localFiles[1].generatedType, 'table');
	assert.equal(result.localFiles[1].generatedMeta.rowSize, 2);
	assert.equal(result.localFiles[1].generatedMeta.columnSize, 2);
	assert.match(result.content, /__TEST_1__/);
	assert.match(result.content, /__TEST_2__/);
});

test('extractGeneratedDocBlocks captures markdown pipe tables as generated tables', () => {
	let index = 0;
	const result = extractGeneratedDocBlocks([
		'| 列1 | 列2 | 列3 |',
		'| --- | --- | --- |',
		'| 文本 | **粗体** | `code` |',
		'| 蓝色 | 颜色文本 | 第三列 |'
	].join('\n'), () => `__TEST_${++index}__`);

	assert.equal(result.localFiles.length, 1);
	assert.equal(result.localFiles[0].generatedType, 'table');
	assert.equal(result.localFiles[0].generatedMeta.rowSize, 3);
	assert.equal(result.localFiles[0].generatedMeta.columnSize, 3);
	assert.equal(result.localFiles[0].generatedMeta.rows[0][0].content, '列1');
	assert.equal(result.localFiles[0].generatedMeta.rows[1][1].content, '**粗体**');
	assert.equal(result.localFiles[0].generatedMeta.rows[2][2].content, '第三列');
	assert.equal(result.content, '__TEST_1__');
});

test('extractGeneratedDocBlocks captures markdown alignment tables with short center delimiter', () => {
	let index = 0;
	const result = extractGeneratedDocBlocks([
		'| 左对齐 | 居中 | 右对齐 |',
		'| :---- | :--: | ----: |',
		'| alpha | beta | gamma |'
	].join('\n'), () => `__TEST_${++index}__`);

	assert.equal(result.localFiles.length, 1);
	assert.equal(result.localFiles[0].generatedType, 'table');
	assert.equal(result.localFiles[0].generatedMeta.columnSize, 3);
	assert.equal(result.content, '__TEST_1__');
});

test('html table parser keeps merged cell positions stable across rows', () => {
	let index = 0;
	const result = extractGeneratedDocBlocks([
		'<table>',
		'<tr><td rowspan="2">A</td><td>B1</td><td>C1</td></tr>',
		'<tr><td colspan="2">B2C2</td></tr>',
		'</table>'
	].join('\n'), () => `__TEST_${++index}__`);

	const tableMeta = result.localFiles[0].generatedMeta;
	assert.equal(tableMeta.rowSize, 2);
	assert.equal(tableMeta.columnSize, 3);
	assert.equal(tableMeta.rows[0][0].content, 'A');
	assert.equal(tableMeta.rows[1][0].content, '');
	assert.equal(tableMeta.rows[1][1].content, 'B2C2');
	assert.equal(tableMeta.rows[1][1].colSpan, 2);
});

test('collectTableMergeRanges converts rowSpan and colSpan into Feishu merge requests', () => {
	const ranges = collectTableMergeRanges({
		rowSize: 2,
		columnSize: 3,
		rows: [
			[
				{ content: 'A', rowSpan: 2 },
				{ content: 'B1' },
				{ content: 'C1' }
			],
			[
				{ content: '' },
				{ content: 'B2C2', colSpan: 2 },
				{ content: '' }
			]
		]
	});

	assert.deepEqual(ranges, [
		{
			row_start_index: 0,
			row_end_index: 2,
			column_start_index: 0,
			column_end_index: 1
		},
		{
			row_start_index: 1,
			row_end_index: 2,
			column_start_index: 1,
			column_end_index: 3
		}
	]);
});

test('extractGeneratedDocBlocks preserves original source order across supported generated block types', () => {
	let index = 0;
	const result = extractGeneratedDocBlocks([
		'<table>',
		'<tr><td>T1</td></tr>',
		'</table>',
		'',
		'[Whiteboard]',
		'',
		'```mermaid',
		'flowchart TD',
		'A-->B',
		'```'
	].join('\n'), () => `__TEST_${++index}__`);

	assert.deepEqual(
		result.localFiles.map((item) => item.generatedType),
		['table', 'whiteboard', 'mermaid']
	);
});

test('extractGeneratedListStructures captures nested markdown lists as generated structures', () => {
	let index = 0;
	const result = extractGeneratedListStructures([
		'- 无序列表 1',
		'- 无序列表 2',
		'    - 二级无序列表',
		'    - 二级无序列表里的 **粗体**',
		'1. 有序列表 1',
		'2. 有序列表 2',
		'    1. 二级有序列表',
		'    2. 二级有序列表里的 `inline code`'
	].join('\n'), () => `__TEST_${++index}__`);

	assert.equal(result.localFiles.length, 1);
	assert.equal(result.localFiles[0].generatedType, 'list');
	assert.equal(result.localFiles[0].generatedMeta.kind, 'list');
	assert.equal(result.localFiles[0].generatedMeta.nodes.length, 4);
	assert.equal(result.localFiles[0].generatedMeta.nodes[1].children.length, 2);
	assert.equal(result.localFiles[0].generatedMeta.nodes[3].children.length, 2);
	assert.equal(result.content, '__TEST_1__');
});

test('extractGeneratedListStructures captures quote sections with nested todo and bullet items', () => {
	let index = 0;
	const result = extractGeneratedListStructures([
		'> 第一层引用',
		'> - 引用中的列表 1',
		'> - [ ] 引用中的未完成任务',
		'>   - 二级补充说明',
		'> 引用里的结尾段落，含 $a+b$。'
	].join('\n'), () => `__TEST_${++index}__`);

	assert.equal(result.localFiles.length, 1);
	assert.equal(result.localFiles[0].generatedMeta.kind, 'quote');
	assert.equal(result.localFiles[0].generatedMeta.quoteText, '第一层引用');
	assert.equal(result.localFiles[0].generatedMeta.nodes[1].kind, 'todo');
	assert.equal(result.localFiles[0].generatedMeta.nodes[1].children[0].kind, 'bullet');
	assert.equal(result.localFiles[0].generatedMeta.nodes[2].kind, 'paragraph');
});

test('buildGeneratedDocBlock returns native Feishu whiteboard block payload', () => {
	const result = buildGeneratedDocBlock({
		generatedType: 'whiteboard',
		generatedMeta: {
			token: 'wb_token_123',
			align: 2
		}
	});

	assert.equal(result.kind, 'block');
	assert.deepEqual(result.block, {
		block_type: 43,
		board: {
			align: 2
		}
	});
});

test('buildGeneratedDocBlock returns descendant table structure payload', () => {
	const result = buildGeneratedDocBlock({
		generatedType: 'table',
		generatedMeta: {
			rowSize: 2,
			columnSize: 2,
			rows: [
				[
					{ content: 'A1' },
					{ content: 'B1' }
				],
				[
					{ content: 'A2', colSpan: 2 },
					{ content: 'B2' }
				]
			]
		}
	});

	assert.equal(result.kind, 'structure');
	assert.equal(result.structure.children_id.length, 1);
	assert.equal(result.structure.descendants[0].block_type, 31);
	assert.equal(result.structure.descendants[0].table.property.row_size, 2);
	assert.equal(result.structure.descendants[0].table.property.column_size, 2);
	assert.equal('merge_info' in result.structure.descendants[0].table.property, false);
	assert.equal(result.structure.descendants[1].block_type, 32);
	assert.equal(result.structure.descendants[2].block_type, 2);
	assert.equal(
		result.structure.descendants[2].text.elements[0].text_run.content,
		'A1'
	);
});

test('buildGeneratedDocBlock returns descendant list structure payload', () => {
	const result = buildGeneratedDocBlock({
		generatedType: 'list',
		generatedMeta: {
			kind: 'list',
			nodes: [
				{
					kind: 'bullet',
					text: '父级列表',
					children: [
						{ kind: 'bullet', text: '**子级列表**', children: [] }
					]
				},
				{
					kind: 'todo',
					text: '任务项',
					checked: true,
					children: []
				}
			]
		}
	});

	assert.equal(result.kind, 'structure');
	assert.equal(result.structure.children_id.length, 2);
	const bulletBlocks = result.structure.descendants.filter((block) => block.block_type === 12);
	const todoBlock = result.structure.descendants.find((block) => block.block_type === 17);
	const boldChildBullet = bulletBlocks.find((block) => block.bullet.elements[0]?.text_run?.text_element_style?.bold);
	assert.equal(bulletBlocks.length, 2);
	assert.ok(boldChildBullet);
	assert.equal(todoBlock.todo.style.done, true);
});

test('buildGeneratedDocBlock keeps inline color styling inside table cells', () => {
	const result = buildGeneratedDocBlock({
		generatedType: 'table',
		generatedMeta: {
			rowSize: 1,
			columnSize: 1,
			rows: [[{ content: '<span style="color:blue">颜色文本</span>' }]]
		}
	});

	assert.equal(result.kind, 'structure');
	const textBlock = result.structure.descendants.find((block) => block.block_type === 2);
	assert.equal(textBlock.text.elements[0].text_run.content, '颜色文本');
	assert.equal(textBlock.text.elements[0].text_run.text_element_style.text_color, 6);
});
