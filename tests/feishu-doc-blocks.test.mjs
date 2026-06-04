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
	extractGeneratedDocBlocks,
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

test('extractGeneratedDocBlocks preserves original source order across generated block types', () => {
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
	assert.equal(result.structure.descendants[0].table.property.merge_info[2].col_span, 2);
	assert.equal(result.structure.descendants[1].block_type, 32);
	assert.equal(result.structure.descendants[2].block_type, 2);
	assert.equal(
		result.structure.descendants[2].text.elements[0].text_run.content,
		'A1'
	);
});
