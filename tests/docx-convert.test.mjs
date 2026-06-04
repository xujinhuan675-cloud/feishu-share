import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Buffer } from 'node:buffer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function loadModule() {
	const result = await build({
		entryPoints: [path.join(rootDir, 'src', 'docx-convert.ts')],
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
	buildDescendantPayloadFromConvertedData,
	shouldPreserveFeishuSpecialLink,
	collectDocxUploadCompatibilityWarnings
} = await loadModule();

test('converted block payload keeps tree order and strips merge metadata', () => {
	const payload = buildDescendantPayloadFromConvertedData({
		first_level_block_ids: ['root-a'],
		blocks: {
			'root-a': {
				block_id: 'root-a',
				block_type: 2,
				children: ['child-a'],
				merge_info: { ignored: true },
				text: { elements: [{ text_run: { content: 'A' } }] }
			},
			'child-a': {
				block_id: 'child-a',
				block_type: 12,
				children: [],
				merge_info: { ignored: true },
				bullet: { elements: [{ text_run: { content: 'B' } }] }
			}
		}
	});

	assert.deepEqual(payload.children_id, ['root-a']);
	assert.deepEqual(payload.descendants.map((item) => item.block_id), ['root-a', 'child-a']);
	assert.equal('merge_info' in payload.descendants[0], false);
	assert.equal('merge_info' in payload.descendants[1], false);
});

test('special Feishu markdown links stay intact during preprocessing', () => {
	assert.equal(shouldPreserveFeishuSpecialLink('Iframe', 'https://example.com/embed'), true);
	assert.equal(shouldPreserveFeishuSpecialLink('Bitable', 'btbl123'), true);
	assert.equal(shouldPreserveFeishuSpecialLink('Normal', 'https://example.com'), false);
});

test('compatibility warnings cover pull-only embed placeholders', () => {
	const warnings = collectDocxUploadCompatibilityWarnings([
		'```mermaid',
		'flowchart TD',
		'```',
		'[Mindnote](mind-123)',
		'[Bitable](btbl-123)',
		'[Widget:chart]',
		''
	].join('\n'));

	assert.equal(warnings.length, 3);
	assert.ok(warnings.some((item) => item.includes('Mindnote')));
	assert.ok(warnings.some((item) => item.includes('Bitable/Sheet')));
	assert.ok(warnings.some((item) => item.includes('图表/小组件')));
});
