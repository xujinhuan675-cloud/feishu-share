import { App, Modal, Notice, Setting } from 'obsidian';
import { FeishuApiService } from './feishu-api';
import { WikiNode, WikiSpace } from './types';
import { Debug } from './debug';

export class WikiSelectModal extends Modal {
	private feishuApi: FeishuApiService;
	private onSelect: (space: WikiSpace, node: WikiNode | null) => void | Promise<void>;
	private spaces: WikiSpace[] = [];
	private selectedSpace: WikiSpace | null = null;
	private currentNode: WikiNode | null = null;
	private nodeStack: WikiNode[] = [];
	private loading = false;

	constructor(app: App, feishuApi: FeishuApiService, onSelect: (space: WikiSpace, node: WikiNode | null) => void | Promise<void>) {
		super(app);
		this.feishuApi = feishuApi;
		this.onSelect = onSelect;
	}

	onOpen(): void {
		void this.loadSpaces();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private async loadSpaces(): Promise<void> {
		this.loading = true;
		this.renderBase('正在加载知识库...');
		try {
			this.spaces = await this.feishuApi.getWikiSpaceList();
			this.loading = false;
			this.renderSpaces();
		} catch (error) {
			this.loading = false;
			Debug.error('Failed to load wiki spaces:', error);
			new Notice(`加载飞书知识库失败: ${(error as Error).message || String(error)}`);
			this.renderBase('加载失败，请检查授权和知识库权限。');
		}
	}

	private renderBase(message?: string): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h2', { text: '选择飞书知识库位置' });
		if (message) {
			contentEl.createDiv({ text: message, cls: 'setting-item-description' });
		}
	}

	private renderSpaces(): void {
		this.renderBase();
		if (!this.spaces.length) {
			this.contentEl.createDiv({ text: '没有找到可用知识库。', cls: 'setting-item-description' });
			return;
		}

		for (const space of this.spaces) {
			new Setting(this.contentEl)
				.setName(space.name || space.space_id)
				.setDesc(space.description || space.space_id)
				.addButton((button) => {
					button.setButtonText('选择根目录').setCta().onClick(async () => {
						await this.onSelect(space, null);
						this.close();
					});
				})
				.addButton((button) => {
					button.setButtonText('浏览节点').onClick(() => {
						this.selectedSpace = space;
						this.currentNode = null;
						this.nodeStack = [];
						void this.renderNodes();
					});
				});
		}
	}

	private async renderNodes(): Promise<void> {
		if (!this.selectedSpace) {
			this.renderSpaces();
			return;
		}

		this.renderBase('正在加载节点...');
		const { contentEl } = this;
		const pathText = [
			this.selectedSpace.name,
			...this.nodeStack.map((node) => node.title)
		].filter(Boolean).join(' / ');
		contentEl.createDiv({ text: pathText, cls: 'setting-item-description' });

		try {
			const parentToken = this.currentNode?.node_token;
			const nodes = await this.feishuApi.getWikiNodeList(this.selectedSpace.space_id, parentToken);

			new Setting(contentEl)
				.setName('使用当前位置')
				.setDesc(parentToken ? '文档将保存到当前节点下。' : '文档将保存到知识库根目录。')
				.addButton((button) => {
					button.setButtonText('选择此位置').setCta().onClick(async () => {
						await this.onSelect(this.selectedSpace as WikiSpace, this.currentNode);
						this.close();
					});
				});

			if (this.nodeStack.length > 0) {
				new Setting(contentEl)
					.setName('返回上一级')
					.addButton((button) => {
						button.setButtonText('返回').onClick(() => {
							this.nodeStack.pop();
							this.currentNode = this.nodeStack[this.nodeStack.length - 1] || null;
							void this.renderNodes();
						});
					});
			}

			if (!nodes.length) {
				contentEl.createDiv({ text: '当前位置没有子节点。', cls: 'setting-item-description' });
				return;
			}

			for (const node of nodes) {
				new Setting(contentEl)
					.setName(node.title || node.node_token)
					.setDesc(node.obj_type || node.node_token)
					.addButton((button) => {
						button.setButtonText('进入').onClick(() => {
							this.currentNode = node;
							this.nodeStack.push(node);
							void this.renderNodes();
						});
					})
					.addButton((button) => {
						button.setButtonText('选择').setCta().onClick(async () => {
							await this.onSelect(this.selectedSpace as WikiSpace, node);
							this.close();
						});
					});
			}
		} catch (error) {
			Debug.error('Failed to load wiki nodes:', error);
			new Notice(`加载知识库节点失败: ${(error as Error).message || String(error)}`);
			this.renderBase('加载节点失败，请检查知识库权限。');
		}
	}
}
