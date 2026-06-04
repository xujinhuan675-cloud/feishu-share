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
		'Inline $a+b$ and block:',
		'$$',
		'c=d',
		'$$'
	].join('\n'));

	assert.equal(Array.isArray(result.inlineDocTokens), true);
	assert.equal(result.inlineDocTokens.length, 4);
	assert.ok(result.inlineDocTokens.some((item) => item.kind === 'text' && item.style?.underline));
	assert.ok(result.inlineDocTokens.some((item) => item.kind === 'text' && item.style?.text_color === 6));
	assert.ok(result.inlineDocTokens.some((item) => item.kind === 'equation' && item.content === 'a+b' && item.displayMode === 'inline'));
	assert.ok(result.inlineDocTokens.some((item) => item.kind === 'equation' && item.content === 'c=d' && item.displayMode === 'block'));
	assert.ok(!result.content.includes('<u>under</u>'));
	assert.ok(!result.content.includes('<span style="color:blue">blue</span>'));
	assert.ok(!result.content.includes('$$'));
});
