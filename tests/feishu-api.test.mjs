import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Buffer } from 'node:buffer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function loadModule() {
	const result = await build({
		entryPoints: [path.join(rootDir, 'src', 'feishu-api.ts')],
		bundle: true,
		format: 'esm',
		platform: 'node',
		write: false,
		external: ['obsidian']
	});
	const obsidianStub = `
		export class Notice {
			setMessage() {}
		}
		export async function requestUrl() {
			throw new Error('requestUrl should not be called in this test');
		}
		export class App {}
		export class TFile {}
		export function normalizePath(input) {
			return String(input || '').replace(/\\\\/g, '/');
		}
	`;
	const obsidianStubUrl = `data:text/javascript;base64,${Buffer.from(obsidianStub).toString('base64')}`;
	const source = result.outputFiles[0].text.replace(/from "obsidian"/g, `from "${obsidianStubUrl}"`);
	const url = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
	return import(url);
}

const { FeishuApiService } = await loadModule();

test('generated structures advance later placeholder indices by inserted root child count', async () => {
	const service = new FeishuApiService({}, { vault: {} });
	const inserted = [];
	const counts = new Map([
		['__LIST_1__', 6],
		['__LIST_2__', 7],
		['__TABLE_1__', 1]
	]);

	service.sortPlaceholdersByOriginalOrder = (blocks) => blocks;
	service.insertGeneratedDocBlock = async (_documentId, placeholderBlock) => {
		inserted.push({
			placeholder: placeholderBlock.placeholder,
			index: placeholderBlock.index
		});
		return {
			blockId: placeholderBlock.placeholder,
			insertedCount: counts.get(placeholderBlock.placeholder) ?? 1
		};
	};
	service.batchReplacePlaceholderText = async () => {};
	service.deleteBlockByPlaceholderText = async () => {};

	const placeholderBlocks = [
		{
			placeholder: '__LIST_1__',
			parentId: 'root',
			index: 0,
			fileInfo: { fileName: 'list-1', generatedType: 'list' }
		},
		{
			placeholder: '__LIST_2__',
			parentId: 'root',
			index: 1,
			fileInfo: { fileName: 'list-2', generatedType: 'list' }
		},
		{
			placeholder: '__TABLE_1__',
			parentId: 'root',
			index: 2,
			fileInfo: { fileName: 'table-1', generatedType: 'table' }
		}
	];

	await service.processFileBlocks('doc-token', placeholderBlocks, []);

	assert.deepEqual(inserted, [
		{ placeholder: '__LIST_1__', index: 0 },
		{ placeholder: '__LIST_2__', index: 7 },
		{ placeholder: '__TABLE_1__', index: 15 }
	]);
});

test('table generated structures apply merge ranges after insertion', async () => {
	const service = new FeishuApiService({}, { vault: {} });
	const applied = [];

	service.insertGeneratedDocStructure = async () => ({
		blockId: 'table-block-1',
		insertedCount: 1
	});
	service.applyTableMergeRanges = async (_documentId, tableBlockId, ranges) => {
		applied.push({ tableBlockId, ranges });
	};

	await service.insertGeneratedDocBlock('doc-token', {
		parentId: 'root',
		index: 0,
		placeholder: '__TABLE_MERGE__',
		fileInfo: {
			fileName: 'merged-table',
			generatedType: 'table',
			generatedMeta: {
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
			}
		}
	});

	assert.deepEqual(applied, [
		{
			tableBlockId: 'table-block-1',
			ranges: [
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
			]
		}
	]);
});
