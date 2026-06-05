import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Buffer } from 'node:buffer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function loadModule() {
	const result = await build({
		entryPoints: [path.join(rootDir, 'src', 'docx-blocks-to-markdown.ts')],
		bundle: true,
		format: 'esm',
		platform: 'node',
		write: false,
		external: ['obsidian']
	});
	const source = result.outputFiles[0].text;
	const url = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
	return import(url);
}

const { DocxBlocksToMarkdown } = await loadModule();

test('docx rich text keeps underline, color, and equation when converting to markdown', () => {
	const markdown = DocxBlocksToMarkdown.convert([
		{
			block_id: 'root',
			block_type: 1,
			children: ['text-1']
		},
		{
			block_id: 'text-1',
			block_type: 2,
			parent_id: 'root',
			children: [],
			text: {
				elements: [
					{ text_run: { content: 'Before ' } },
					{ text_run: { content: 'under', text_element_style: { underline: true } } },
					{ text_run: { content: ' ' } },
					{ text_run: { content: 'blue', text_element_style: { text_color: 6 } } },
					{ text_run: { content: ' ' } },
					{ equation: { content: 'x^2+y^2=z^2' } }
				]
			}
		}
	]);

	assert.ok(markdown.includes('<u>under</u>'));
	assert.ok(markdown.includes('<span style="color:blue">blue</span>'));
	assert.ok(markdown.includes('$x^2+y^2=z^2$'));
});

test('docx mermaid widget keeps mindmap syntax instead of degrading', () => {
	const markdown = DocxBlocksToMarkdown.convert([
		{
			block_id: 'root',
			block_type: 1,
			children: ['widget-1']
		},
		{
			block_id: 'widget-1',
			block_type: 40,
			parent_id: 'root',
			children: [],
			add_ons: {
				component_type_id: 'blk_631fefbbae02400430b8f9f4',
				record: JSON.stringify({
					data: 'mindmap\n  root((Sync))\n    Mermaid'
				})
			}
		}
	]);

	assert.ok(markdown.includes('```mermaid'));
	assert.ok(markdown.includes('mindmap'));
	assert.ok(!markdown.includes('[Widget:'));
});
