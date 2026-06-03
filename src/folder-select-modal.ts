import { App, Modal, Notice, Setting } from 'obsidian';
import { FeishuApiService } from './feishu-api';
import { Debug } from './debug';

type FeishuFolder = {
	name: string;
	token?: string;
	folder_token?: string;
	parent_token?: string;
	[key: string]: any;
};

export class FolderSelectModal extends Modal {
	private feishuApi: FeishuApiService;
	private onSelect: (folder: FeishuFolder | null) => void | Promise<void>;
	private currentFolderToken = '';
	private pathStack: Array<{ name: string; token: string }> = [];
	private loading = false;

	constructor(app: App, feishuApi: FeishuApiService, onSelect: (folder: FeishuFolder | null) => void | Promise<void>) {
		super(app);
		this.feishuApi = feishuApi;
		this.onSelect = onSelect;
	}

	onOpen(): void {
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private async render(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h2', { text: '选择飞书文件夹' });

		const breadcrumbText = ['我的空间', ...this.pathStack.map((item) => item.name)].join(' / ');
		contentEl.createDiv({ text: breadcrumbText, cls: 'setting-item-description' });

		new Setting(contentEl)
			.setName('使用当前位置')
			.setDesc(this.currentFolderToken ? '文档将上传到当前文件夹。' : '文档将上传到我的空间根目录。')
			.addButton((button) => {
				button
					.setButtonText(this.currentFolderToken ? '选择此文件夹' : '选择我的空间')
					.setCta()
					.onClick(async () => {
						await this.onSelect(this.currentFolderToken ? this.pathStack[this.pathStack.length - 1] : null);
						this.close();
					});
			});

		if (this.currentFolderToken) {
			new Setting(contentEl)
				.setName('返回上一级')
				.addButton((button) => {
					button.setButtonText('返回').onClick(() => {
						this.pathStack.pop();
						const last = this.pathStack[this.pathStack.length - 1];
						this.currentFolderToken = last?.token || '';
						void this.render();
					});
				});
		}

		if (this.loading) {
			contentEl.createDiv({ text: '正在加载文件夹...', cls: 'setting-item-description' });
			return;
		}

		this.loading = true;
		try {
			const response = await this.feishuApi.getFolderList(this.currentFolderToken || undefined);
			const folders: FeishuFolder[] = response?.data?.folders || response?.data?.files || [];
			this.loading = false;

			if (!folders.length) {
				contentEl.createDiv({ text: '当前目录没有可选择的子文件夹。', cls: 'setting-item-description' });
				return;
			}

			for (const folder of folders) {
				const token = String(folder.folder_token || folder.token || '');
				new Setting(contentEl)
					.setName(folder.name || token)
					.setDesc(token)
					.addButton((button) => {
						button.setButtonText('进入').onClick(() => {
							if (!token) return;
							this.currentFolderToken = token;
							this.pathStack.push({ name: folder.name || token, token });
							void this.render();
						});
					})
					.addButton((button) => {
						button.setButtonText('选择').setCta().onClick(async () => {
							await this.onSelect({ ...folder, token, folder_token: token });
							this.close();
						});
					});
			}
		} catch (error) {
			this.loading = false;
			Debug.error('Failed to load Feishu folders:', error);
			new Notice(`加载飞书文件夹失败: ${(error as Error).message || String(error)}`);
		}
	}
}
