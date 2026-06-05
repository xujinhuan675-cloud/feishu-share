import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Buffer } from 'node:buffer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function loadModule() {
	const result = await build({
		entryPoints: [path.join(rootDir, 'src', 'bitable-fields.ts')],
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
	bitableFieldToPlainText,
	bitableFieldToDisplayText,
	bitableFieldToFrontMatterValue,
	normalizeBitableWriteValue
} = await loadModule();

test('plain text extractor understands structured hyperlink and rich objects', () => {
	assert.equal(
		bitableFieldToPlainText([{ text: 'Alpha' }, { link: 'https://example.com' }]),
		'Alpha, https://example.com'
	);
	assert.equal(bitableFieldToPlainText({ name: 'Owner A' }), 'Owner A');
});

test('empty structured bitable objects are treated as empty instead of JSON blobs', () => {
	const emptyRelation = {
		record_ids: null,
		table_id: 'tbl02ZXD0Kkb2xOB',
		text: null,
		text_arr: [],
		type: 'text'
	};
	assert.equal(bitableFieldToPlainText(emptyRelation), '');
	assert.equal(bitableFieldToDisplayText(emptyRelation), '');
	assert.equal(bitableFieldToFrontMatterValue(emptyRelation), undefined);
});

test('front matter conversion keeps array-like multiselect values', () => {
	assert.deepEqual(
		bitableFieldToFrontMatterValue([{ name: 'one' }, 'two'], 4),
		['one', 'two']
	);
});

test('typed writer keeps select and multi-select values in Feishu-friendly shapes', () => {
	assert.equal(
		normalizeBitableWriteValue('published', { name: 'status', type: 3 }),
		'published'
	);
	assert.deepEqual(
		normalizeBitableWriteValue('alpha, beta', { name: 'tags', type: 4 }),
		['alpha', 'beta']
	);
});

test('typed writer converts checkbox and numeric fields safely', () => {
	assert.equal(
		normalizeBitableWriteValue('true', { name: 'done', type: 7 }),
		true
	);
	assert.equal(
		normalizeBitableWriteValue('42', { name: 'score', type: 2 }),
		42
	);
});

test('typed writer upgrades hyperlink and relation fields from simple text', () => {
	assert.deepEqual(
		normalizeBitableWriteValue('https://example.com/doc', { name: 'link', type: 15 }),
		{ text: 'https://example.com/doc', link: 'https://example.com/doc' }
	);
	assert.deepEqual(
		normalizeBitableWriteValue('recA,recB', { name: 'related', type: 18 }),
		{ link_record_ids: ['recA', 'recB'] }
	);
});
