import { App, PluginSettingTab, Setting, Notice, Modal } from 'obsidian';
import FeishuPlugin from '../main';
import { ManualAuthModal } from './manual-auth-modal';
import { FolderSelectModal } from './folder-select-modal';
import { WikiSelectModal } from './wiki-select-modal';
import { buildSyncStatusView, filterSyncStates, formatSyncBatchSummary, formatSyncStatus, getSyncStatusCounts, searchSyncStates, sortSyncStates } from './sync-diagnostics';
import type { BitableTableOption, ScheduledSyncReport, ScheduledSyncScope, SyncStateItem } from './types';
import type { SyncStatusCounts, SyncStatusFilter } from './sync-diagnostics';

export class FeishuSettingTab extends PluginSettingTab {
	plugin: FeishuPlugin;
	private activeTab: 'basic' | 'history' | 'status' = 'basic';
	private historySearchQuery: string = '';
	private syncStatusSearchQuery: string = '';
	private syncStatusFilter: SyncStatusFilter = 'all';
	private selectedHistoryDocTokens: Set<string> = new Set();

	private isNotFoundError(error: unknown): boolean {
		const msg = (error as any)?.message ? String((error as any).message) : String(error);
		const status = (error as any)?.status;
		return status === 404 || /status\s*404/i.test(msg) || /404/.test(msg);
	}

	private isTokenInvalidDeleteError(error: unknown): boolean {
		const msg = (error as any)?.message ? String((error as any).message) : String(error);
		return /token\s*无效/i.test(msg) || /token无效/i.test(msg) || /Token无效/i.test(msg);
	}

	constructor(app: App, plugin: FeishuPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('style', {
			text: `
				.feishu-settings-tabs{display:flex;gap:10px;align-items:center;margin-bottom:12px;}
				.feishu-settings-tab-btn{margin:0;}
				.share-search-container{margin:10px 0;}
				.share-search-input{width:100%;box-sizing:border-box;}
				.share-batch-toolbar{display:flex;align-items:center;justify-content:space-between;margin:10px 0;gap:12px;}
				.share-batch-left{display:flex;align-items:center;gap:8px;}
				.share-batch-right{display:flex;align-items:center;gap:8px;}
				.upload-history-container{display:flex;flex-direction:column;gap:10px;margin-top:10px;}
				.upload-history-item{display:flex;gap:10px;padding:10px 12px;border:1px solid var(--background-modifier-border);border-radius:10px;background:var(--background-secondary);}
				.upload-history-item:hover{background:var(--background-secondary-alt);}
				.share-item-checkbox{margin-top:6px;}
				.upload-history-content{flex:1;min-width:0;}
				.upload-history-header{display:flex;align-items:center;justify-content:space-between;gap:10px;}
				.upload-history-title{font-size:16px;font-weight:700;line-height:1.25;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
				.upload-history-meta{display:flex;align-items:center;gap:10px;flex-shrink:0;}
				.upload-history-time{opacity:.65;font-size:12px;white-space:nowrap;}
				.upload-history-actions{display:flex;align-items:center;gap:8px;}
				.upload-history-action-btn{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:6px;cursor:pointer;opacity:.85;user-select:none;}
				.upload-history-action-btn:hover{opacity:1;background:var(--background-modifier-hover);}
				.upload-history-link-row{margin-top:6px;}
				.upload-history-link{display:inline-block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-accent);text-decoration:underline;}
				.sync-status-badge{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:999px;font-size:12px;font-weight:600;background:var(--background-modifier-border);white-space:nowrap;}
				.sync-status-badge.synced{color:var(--text-success);}
				.sync-status-badge.conflict{color:var(--text-error);}
				.sync-status-badge.error{color:var(--text-error);}
				.sync-status-summary-line{margin-top:6px;font-size:12px;color:var(--text-muted);line-height:1.45;}
				.sync-status-recommendation{display:flex;align-items:flex-start;gap:6px;margin-top:6px;font-size:12px;line-height:1.45;}
				.sync-status-recommendation.healthy{color:var(--text-success);}
				.sync-status-recommendation.attention{color:var(--text-warning);}
				.sync-status-recommendation.blocked{color:var(--text-error);}
				.sync-status-recommendation-label{font-weight:700;white-space:nowrap;}
				.sync-status-detail{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;font-size:12px;line-height:1.4;}
				.sync-status-detail-chip{display:inline-flex;align-items:center;gap:4px;max-width:100%;padding:2px 7px;border:1px solid var(--background-modifier-border);border-radius:6px;background:var(--background-primary);word-break:break-all;}
				.sync-status-detail-chip.observed{border-color:var(--interactive-accent);background:var(--background-secondary-alt);}
				.sync-status-detail-chip.error{border-color:var(--text-error);color:var(--text-error);}
				.sync-status-detail-label{color:var(--text-muted);white-space:nowrap;}
				.sync-status-toolbar{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:10px 0;flex-wrap:wrap;}
				.sync-status-filter-group{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}
				.sync-status-filter-btn{height:28px;padding:0 10px;border-radius:6px;cursor:pointer;}
				.sync-status-filter-btn.is-active{background:var(--interactive-accent);color:var(--text-on-accent);}
				.sync-status-filter-btn.is-empty{opacity:.45;}
				.sync-status-summary{font-size:12px;color:var(--text-muted);}
				.bitable-field-mapping-panel{margin:10px 0 14px;padding:10px 12px;border:1px solid var(--background-modifier-border);border-radius:8px;background:var(--background-secondary);}
				.bitable-field-mapping-toolbar{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px;}
				.bitable-field-mapping-title{font-weight:700;}
				.bitable-field-mapping-actions{display:flex;align-items:center;gap:8px;}
				.bitable-field-mapping-grid{display:grid;grid-template-columns:minmax(120px, 180px) minmax(160px, 1fr);gap:8px 10px;align-items:center;}
				.bitable-field-mapping-label{font-size:12px;color:var(--text-muted);}
				.bitable-field-mapping-select{width:100%;box-sizing:border-box;}
				.bitable-field-mapping-hint{margin-top:8px;font-size:12px;color:var(--text-muted);}
			`
		});

		const tabBar = containerEl.createDiv({ cls: 'feishu-settings-tabs' });
		const basicTabBtn = tabBar.createEl('button', {
			text: '基础设置',
			cls: `feishu-settings-tab-btn${this.activeTab === 'basic' ? ' is-active' : ''}`
		});
		const historyTabBtn = tabBar.createEl('button', {
			text: '已上传文档列表',
			cls: `feishu-settings-tab-btn${this.activeTab === 'history' ? ' is-active' : ''}`
		});
		const statusTabBtn = tabBar.createEl('button', {
			text: '同步状态',
			cls: `feishu-settings-tab-btn${this.activeTab === 'status' ? ' is-active' : ''}`
		});
		basicTabBtn.addEventListener('click', () => {
			this.activeTab = 'basic';
			this.display();
		});
		historyTabBtn.addEventListener('click', () => {
			this.activeTab = 'history';
			this.display();
		});
		statusTabBtn.addEventListener('click', () => {
			this.activeTab = 'status';
			this.display();
		});

		const basicPanel = containerEl.createDiv({ cls: 'feishu-settings-tab-panel' });
		const historyPanel = containerEl.createDiv({ cls: 'feishu-settings-tab-panel' });
		const statusPanel = containerEl.createDiv({ cls: 'feishu-settings-tab-panel' });
		basicPanel.style.display = this.activeTab === 'basic' ? '' : 'none';
		historyPanel.style.display = this.activeTab === 'history' ? '' : 'none';
		statusPanel.style.display = this.activeTab === 'status' ? '' : 'none';

		this.renderBasicSettings(basicPanel);
		this.renderHistoryPanel(historyPanel);
		this.renderSyncStatusPanel(statusPanel);
	}

	private renderBasicSettings(containerEl: HTMLElement): void {
		// 应用配置部分
		containerEl.createEl('h3', { text: '🔧 应用配置' });

		// App ID
		new Setting(containerEl)
			.setName('App ID')
			.setDesc('飞书应用的 App ID')
			.addText(text => text
				.setPlaceholder('输入飞书应用的 App ID')
				.setValue(this.plugin.settings.appId)
				.onChange(async (value: string) => {
					this.plugin.settings.appId = value.trim();
					await this.plugin.saveSettings();
					}));

		// App Secret
		new Setting(containerEl)
			.setName('App Secret')
			.setDesc('飞书应用的 App Secret')
			.addText(text => {
				text.setPlaceholder('输入飞书应用的 App Secret')
					.setValue(this.plugin.settings.appSecret)
					.onChange(async (value: string) => {
						this.plugin.settings.appSecret = value.trim();
						await this.plugin.saveSettings();
						});
				text.inputEl.type = 'password';
			});

		// 回调地址
		new Setting(containerEl)
			.setName('OAuth回调地址')
			.setDesc('需要填写可公网访问的回调页；仓库已附带 oauth-callback/index.html，可部署到任意静态站点')
			.addText(text => text
				.setPlaceholder('https://your-domain.example/feishu-oauth-callback/')
				.setValue(this.plugin.settings.callbackUrl)
				.onChange(async (value: string) => {
					this.plugin.settings.callbackUrl = value.trim();
					await this.plugin.saveSettings();
					}));

		// 授权部分
		containerEl.createEl('h3', { text: '🔐 授权管理' });

		// 当前授权状态
		const authStatusEl = containerEl.createDiv('setting-item');
		const authStatusInfo = authStatusEl.createDiv('setting-item-info');
		authStatusInfo.createDiv('setting-item-name').setText('授权状态');
		
		const statusDesc = authStatusInfo.createDiv('setting-item-description');
		if (this.plugin.settings.userInfo) {
			const statusSpan = statusDesc.createEl('span', { text: '✅ 已授权' });
			statusSpan.addClass('mod-success');
			statusDesc.createEl('br');
			const userInfoDiv = statusDesc.createDiv({ cls: 'setting-item-description' });
			const userLabel = userInfoDiv.createEl('strong');
			userLabel.textContent = '用户：';
			userInfoDiv.appendText(this.plugin.settings.userInfo.name);
			userInfoDiv.createEl('br');
			const emailLabel = userInfoDiv.createEl('strong');
			emailLabel.textContent = '邮箱：';
			userInfoDiv.appendText(this.plugin.settings.userInfo.email);
		} else {
			const statusSpan = statusDesc.createEl('span', { text: '❌ 未授权' });
			statusSpan.addClass('mod-warning');
		}

		// 自动授权按钮（推荐）
		new Setting(containerEl)
			.setName('🚀 一键授权（推荐）')
			.setDesc('自动打开浏览器完成授权，通过云端回调自动返回授权结果，无需手动操作')
			.addButton(button => {
				button
					.setButtonText('🚀 一键授权')
					.setCta()
					.onClick(() => {
						this.startAutoAuth();
					});
			});

		// 手动授权按钮（备用）
		new Setting(containerEl)
			.setName('📝 手动授权（备用）')
			.setDesc('如果一键授权遇到问题，可以使用传统的手动复制粘贴授权方式')
			.addButton(button => {
				button
					.setButtonText('手动授权')
					.onClick(() => {
						this.startManualAuth();
					});
			});

		// 清除授权
		if (this.plugin.settings.userInfo) {
			new Setting(containerEl)
				.setName('清除授权')
				.setDesc('清除当前的授权信息')
				.addButton(button => {
					button
						.setButtonText('🗑️ 清除授权')
						.setWarning()
						.onClick(async () => {
							this.plugin.settings.accessToken = '';
							this.plugin.settings.refreshToken = '';
							this.plugin.settings.userInfo = null;
							await this.plugin.saveSettings();
							this.plugin.feishuApi.updateSettings(this.plugin.settings);
							new Notice('✅ 授权信息已清除');
							this.display(); // 刷新界面
						});
				});


		}

		// 分享目标设置部分
		containerEl.createEl('h3', { text: '🎯 分享目标设置' });

		// 目标类型选择
		new Setting(containerEl)
			.setName('分享目标')
			.setDesc('选择文档分享的目标位置')
			.addDropdown(dropdown => {
				dropdown
					.addOption('drive', '云空间')
					.addOption('wiki', '知识库')
					.setValue(this.plugin.settings.targetType || 'drive')
					.onChange(async (value: 'drive' | 'wiki') => {
						this.plugin.settings.targetType = value;
						await this.plugin.saveSettings();
						this.plugin.feishuApi.updateSettings(this.plugin.settings);
						this.display(); // 刷新界面以显示相应的设置项
					});
			});

		// 根据目标类型显示不同的设置
		if (this.plugin.settings.targetType === 'wiki') {
			this.addWikiSettings(containerEl);
		} else {
			this.addDriveSettings(containerEl);
		}

		// 内容处理设置部分
		containerEl.createEl('h3', { text: '📝 内容处理设置' });

		// 文档标题来源设置
		new Setting(containerEl)
			.setName('文档标题来源')
			.setDesc('选择生成的飞书文档标题使用哪个来源')
			.addDropdown(dropdown => {
				dropdown
					.addOption('filename', '文件名 (Filename)')
					.addOption('frontmatter', 'YAML Front Matter 的 "title" 属性')
					.setValue(this.plugin.settings.titleSource)
					.onChange(async (value: 'filename' | 'frontmatter') => {
						this.plugin.settings.titleSource = value;
						await this.plugin.saveSettings();
					});
			});

		// 文档属性（Front Matter）处理设置
		new Setting(containerEl)
			.setName('文档属性（Front Matter）')
			.setDesc('选择如何处理笔记顶部的 YAML 属性区')
			.addDropdown(dropdown => {
				dropdown
					.addOption('remove', '移除 (Remove)')
					.addOption('keep-as-code', '保留为代码块 (Keep as Code Block)')
					.setValue(this.plugin.settings.frontMatterHandling)
					.onChange(async (value: 'remove' | 'keep-as-code') => {
						this.plugin.settings.frontMatterHandling = value;
						await this.plugin.saveSettings();
					});
			});

		// 子文档上传开关
		new Setting(containerEl)
			.setName('子文档上传')
			.setDesc('是否处理和上传笔记中引用的其他 Markdown 文件作为子文档')
			.addToggle(toggle => {
				toggle
					.setValue(this.plugin.settings.enableSubDocumentUpload)
					.onChange(async (value: boolean) => {
						this.plugin.settings.enableSubDocumentUpload = value;
						await this.plugin.saveSettings();
					});
			});

		// 本地图片上传开关
		new Setting(containerEl)
			.setName('本地图片上传')
			.setDesc('是否上传笔记中引用的本地图片文件到飞书')
			.addToggle(toggle => {
				toggle
					.setValue(this.plugin.settings.enableLocalImageUpload)
					.onChange(async (value: boolean) => {
						this.plugin.settings.enableLocalImageUpload = value;
						await this.plugin.saveSettings();
					});
			});

		// 本地附件上传开关
		new Setting(containerEl)
			.setName('本地附件上传')
			.setDesc('是否上传笔记中引用的本地附件文件（如 PDF、Word 等）到飞书')
			.addToggle(toggle => {
				toggle
					.setValue(this.plugin.settings.enableLocalAttachmentUpload)
					.onChange(async (value: boolean) => {
						this.plugin.settings.enableLocalAttachmentUpload = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('上传文件列表')
			.setDesc('每行一个匹配项（文件扩展名或路径片段），用于限制本地图片和附件上传范围。留空表示不限制。')
			.then(setting => {
				const textarea = setting.controlEl.createEl('textarea', {
					attr: {
						rows: '4',
						placeholder: '.pdf\n.docx\nassets/'
					}
				});
				textarea.addClass('mod-align-left');
				textarea.value = (this.plugin.settings.uploadFileList || '').trim();
				textarea.addEventListener('change', async () => {
					this.plugin.settings.uploadFileList = textarea.value;
					await this.plugin.saveSettings();
				});
			});

		// 分享标记开关
		new Setting(containerEl)
			.setName('自动添加分享标记')
			.setDesc('分享成功后，自动在笔记的 文档属性（Front Matter） 中添加分享标记（feishushare: true、分享链接和时间）')
			.addToggle(toggle => {
				toggle
					.setValue(this.plugin.settings.enableShareMarkInFrontMatter)
					.onChange(async (value: boolean) => {
						this.plugin.settings.enableShareMarkInFrontMatter = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('远端覆盖前备份')
			.setDesc('从飞书文档或多维表格覆盖本地笔记前，自动把当前版本备份到 Feishu Backups 文件夹。')
			.addToggle(toggle => {
				toggle
					.setValue(this.plugin.settings.enableOverwriteBackup !== false)
					.onChange(async (value: boolean) => {
						this.plugin.settings.enableOverwriteBackup = value;
						await this.plugin.saveSettings();
					});
			});

		// 代码块过滤（多选：每行一个语言名）
		new Setting(containerEl)
			.setName('代码块过滤')
			.setDesc('每行一个代码块语言（大小写不敏感）。匹配的 fenced code 将被移除。例如：meta-bind-embed、dataviewjs')
			.then(setting => {
				const textarea = setting.controlEl.createEl('textarea', {
					attr: {
						rows: '4',
						placeholder: 'meta-bind-embed\ndataviewjs'
					}
				});
				textarea.addClass('mod-align-left');
				textarea.value = (this.plugin.settings.codeBlockFilterLanguages || []).join('\n');
				textarea.addEventListener('change', async () => {
					const lines = textarea.value
						.split(/\r?\n/)
						.map((s: string) => s.trim())
						.filter(Boolean);
					this.plugin.settings.codeBlockFilterLanguages = lines;
					await this.plugin.saveSettings();
				});
			});

		// 通知设置部分
		containerEl.createEl('h3', { text: '🔔 通知设置' });
		new Setting(containerEl)
			.setName('取消分享状态通知')
			.setDesc('启用后不显示分享“过程状态”通知（错误和最终成功仍提示）')
			.addToggle(toggle => {
				toggle
					.setValue(!!this.plugin.settings.suppressShareNotices)
					.onChange(async (value: boolean) => {
						this.plugin.settings.suppressShareNotices = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('简洁成功通知')
			.setDesc('启用后成功仅显示一行提示；关闭时显示带“复制/打开”按钮的通知')
			.addToggle(toggle => {
				toggle
					.setValue(!!this.plugin.settings.simpleSuccessNotice)
					.onChange(async (value: boolean) => {
						this.plugin.settings.simpleSuccessNotice = value;
						await this.plugin.saveSettings();
					});
			});

		// 分享权限设置部分
		containerEl.createEl('h3', { text: '🔗 分享权限设置' });

		// 启用链接分享开关
		new Setting(containerEl)
			.setName('启用链接分享')
			.setDesc('仅对新上传/更新时生效；已上传文档请在“已上传文档列表”中进行权限设置')
			.addToggle(toggle => {
				toggle
					.setValue(this.plugin.settings.enableLinkShare)
					.onChange(async (value: boolean) => {
						this.plugin.settings.enableLinkShare = value;
						await this.plugin.saveSettings();
						this.display(); // 刷新界面以显示/隐藏权限选项
					});
			});

		// 链接分享权限类型（仅在启用时显示）
		if (this.plugin.settings.enableLinkShare) {
			new Setting(containerEl)
				.setName('链接分享权限')
				.setDesc('仅对新上传/更新时生效。注意：互联网访问需要企业管理员允许外部分享')
				.addDropdown(dropdown => {
					dropdown
						.addOption('anyone_readable', '🌐 互联网上获得链接的任何人可阅读')
						.addOption('anyone_editable', '🌐 互联网上获得链接的任何人可编辑')
						.addOption('tenant_readable', '🏢 组织内获得链接的人可阅读')
						.addOption('tenant_editable', '🏢 组织内获得链接的人可编辑')
						.setValue(this.plugin.settings.linkSharePermission)
						.onChange(async (value: 'anyone_readable' | 'anyone_editable' | 'tenant_readable' | 'tenant_editable') => {
							this.plugin.settings.linkSharePermission = value;
							await this.plugin.saveSettings();
						});
				});
		}

		// 同步设置（从 feishusync 迁入，基于 feishushare-main 扩展）
		containerEl.createEl('h3', { text: '🔄 同步设置' });

		new Setting(containerEl)
			.setName('同步目标')
			.setDesc('选择同步云文档（docx）/多维表格（bitable）或两者')
			.addDropdown(dropdown => {
				dropdown
					.addOption('docx', '云文档（docx）')
					.addOption('bitable', '多维表格（bitable）')
					.addOption('both', '两者都同步')
					.setValue(this.plugin.settings.syncTarget || 'docx')
					.onChange(async (value: 'docx' | 'bitable' | 'both') => {
						this.plugin.settings.syncTarget = value;
						await this.plugin.saveSettings();
						this.display();
					});
			});

		new Setting(containerEl)
			.setName('批量同步范围')
			.setDesc('选择批量同步时包含哪些文件')
			.addDropdown(dropdown => {
				dropdown
					.addOption('current_file', '当前文件')
					.addOption('current_folder', '当前文件夹（同级）')
					.addOption('custom_folder', '自定义文件夹')
					.addOption('vault_all', '全库')
					.setValue(this.plugin.settings.batchSyncScope || 'current_file')
					.onChange(async (value: 'current_file' | 'current_folder' | 'custom_folder' | 'vault_all') => {
						this.plugin.settings.batchSyncScope = value;
						await this.plugin.saveSettings();
						this.display();
					});
			});

		if ((this.plugin.settings.batchSyncScope || 'current_file') === 'custom_folder') {
			new Setting(containerEl)
				.setName('自定义同步文件夹路径')
				.setDesc('填写 Obsidian vault 内的文件夹路径，例如：3-Task/IOTO研发')
				.addText(text => text
					.setPlaceholder('例如：3-Task/IOTO研发')
					.setValue(this.plugin.settings.batchSyncCustomFolder || '')
					.onChange(async (value: string) => {
						this.plugin.settings.batchSyncCustomFolder = value.trim();
						await this.plugin.saveSettings();
					}));
		}

		new Setting(containerEl)
			.setName('启用定时智能同步')
			.setDesc('按固定间隔执行非交互式智能同步；遇到冲突时只记录状态，不弹出选择框')
			.addToggle(toggle => {
				toggle
					.setValue(!!this.plugin.settings.enableScheduledSync)
					.onChange(async (value: boolean) => {
						this.plugin.settings.enableScheduledSync = value;
						await this.plugin.saveSettings();
						this.display();
					});
			});

		if (this.plugin.settings.enableScheduledSync) {
			new Setting(containerEl)
				.setName('定时同步间隔（分钟）')
				.setDesc('最小 5 分钟，默认 30 分钟')
				.addText(text => text
					.setPlaceholder('30')
					.setValue(String(this.plugin.settings.scheduledSyncIntervalMinutes || 30))
					.onChange(async (value: string) => {
						const parsed = Number(value);
						this.plugin.settings.scheduledSyncIntervalMinutes = Number.isFinite(parsed)
							? Math.max(5, Math.min(24 * 60, Math.round(parsed)))
							: 30;
						await this.plugin.saveSettings();
					}));

			new Setting(containerEl)
				.setName('定时同步范围')
				.setDesc('推荐选择“已建立映射的文件”，避免依赖当前活动笔记')
				.addDropdown(dropdown => {
					dropdown
						.addOption('tracked_files', '已建立映射的文件')
						.addOption('current_file', '当前文件')
						.addOption('current_folder', '当前文件夹（同级）')
						.addOption('custom_folder', '自定义文件夹')
						.addOption('vault_all', '全库')
						.setValue((this.plugin.settings.scheduledSyncScope || 'tracked_files') as ScheduledSyncScope)
						.onChange(async (value: ScheduledSyncScope) => {
							this.plugin.settings.scheduledSyncScope = value;
							await this.plugin.saveSettings();
							this.display();
						});
				});

			if ((this.plugin.settings.scheduledSyncScope || 'tracked_files') === 'custom_folder') {
				new Setting(containerEl)
					.setName('定时同步文件夹路径')
					.setDesc('仅对定时同步生效')
					.addText(text => text
						.setPlaceholder('例如：3-Task/IOTO研发')
						.setValue(this.plugin.settings.scheduledSyncCustomFolder || '')
						.onChange(async (value: string) => {
							this.plugin.settings.scheduledSyncCustomFolder = value.trim();
							await this.plugin.saveSettings();
						}));
			}

			new Setting(containerEl)
				.setName('启动后执行一次')
				.setDesc('Obsidian 启动约 15 秒后自动跑一次定时同步范围')
				.addToggle(toggle => {
					toggle
						.setValue(!!this.plugin.settings.scheduledSyncRunOnStartup)
						.onChange(async (value: boolean) => {
							this.plugin.settings.scheduledSyncRunOnStartup = value;
							await this.plugin.saveSettings();
						});
				});

			new Setting(containerEl)
				.setName('立即执行一次定时同步')
				.setDesc('按当前定时同步范围手动执行一次非交互式智能同步')
				.addButton(btn => {
					btn
						.setButtonText('立即执行')
						.setCta()
						.onClick(async () => {
							await this.plugin.runScheduledSmartSync('manual', true);
							this.display();
						});
				});
			const reportText = this.describeScheduledSyncReport(this.plugin.settings.scheduledSyncReport);
			if (reportText) {
				const reportEl = containerEl.createDiv({ cls: 'setting-item-description' });
				reportEl.style.marginTop = '-4px';
				reportEl.style.marginBottom = '12px';
				reportEl.setText(reportText);
			}
		}

		new Setting(containerEl)
			.setName('上传历史映射')
			.setDesc('用于将笔记内的 [[双链]] 自动替换为对应飞书文档链接，并支持“原 URL 覆盖更新”')
			.addButton(btn => {
				btn
					.setButtonText('清空映射')
					.setWarning()
					.onClick(async () => {
						this.plugin.settings.uploadHistory = [];
						this.plugin.settings.syncStates = [];
						await this.plugin.saveSettings();
						new Notice('✅ 已清空上传历史映射');
					});
			});

		// bitable 配置
		if ((this.plugin.settings.syncTarget || 'docx') === 'bitable' || (this.plugin.settings.syncTarget || 'docx') === 'both') {
			containerEl.createEl('h4', { text: '📊 多维表格（bitable）同步配置' });
			const normalizeBitableInput = (input: string) => {
				const raw = String(input || '').trim();
				const cleaned = raw
					.replace(/^[\s"'“”‘’`]+/, '')
					.replace(/[\s"'“”‘’`]+$/, '')
					.trim();
				return { raw, cleaned };
			};
			const extractBitableFromText = (text: string): { appToken?: string; tableId?: string } => {
				const s = String(text || '');
				const appTokenFromApps = s.match(/\/apps\/([A-Za-z0-9_-]+)/)?.[1];
				const appTokenFromBase = s.match(/\/(?:base|app)\/([A-Za-z0-9_-]+)/)?.[1];
				const appToken = appTokenFromApps || appTokenFromBase;
				const tableId = s.match(/\b(tbl[A-Za-z0-9_-]+)\b/)?.[1];
				return { appToken, tableId };
			};
			new Setting(containerEl)
				.setName('Bitable App Token')
				.setDesc('多维表格应用 Token（如：bascnxxxxxxxx）')
				.addText(text => text
					.setPlaceholder('bascn...')
					.setValue(this.plugin.settings.bitableAppToken || '')
					.onChange(async (value: string) => {
						const prevAppToken = this.plugin.settings.bitableAppToken || '';
						const { cleaned } = normalizeBitableInput(value);
						const extracted = extractBitableFromText(cleaned);
						this.plugin.settings.bitableAppToken = (extracted.appToken || cleaned).trim();
						if (extracted.tableId) {
							this.plugin.settings.bitableTableId = extracted.tableId.trim();
						}
						if ((this.plugin.settings.bitableAppToken || '') !== prevAppToken) {
							this.plugin.settings.bitableTableOptionsCache = [];
							this.plugin.settings.bitableFieldNamesCache = [];
						}
						await this.plugin.saveSettings();
					}));

			new Setting(containerEl)
				.setName('Bitable Table ID')
				.setDesc('多维表格表格 ID（如：tblxxxxxxxx）')
				.addText(text => text
					.setPlaceholder('tbl...')
					.setValue(this.plugin.settings.bitableTableId || '')
					.onChange(async (value: string) => {
						const prevTableId = this.plugin.settings.bitableTableId || '';
						const { cleaned } = normalizeBitableInput(value);
						const extracted = extractBitableFromText(cleaned);
						this.plugin.settings.bitableTableId = (extracted.tableId || cleaned).trim();
						if (extracted.appToken) {
							this.plugin.settings.bitableAppToken = extracted.appToken.trim();
						}
						if ((this.plugin.settings.bitableTableId || '') !== prevTableId) {
							this.plugin.settings.bitableFieldNamesCache = [];
						}
						await this.plugin.saveSettings();
					}));

			this.renderBitableTableAssistant(containerEl);

			new Setting(containerEl)
				.setName('不同步字段')
				.setDesc('每行一个或用逗号分隔；可填写逻辑字段或映射后的表格字段名。例如：content, frontmatter')
				.addTextArea(text => text
					.setPlaceholder('例如：content\nfrontmatter')
					.setValue(this.plugin.settings.bitableExcludedFields || '')
					.onChange(async (value: string) => {
						this.plugin.settings.bitableExcludedFields = value;
						await this.plugin.saveSettings();
					}));

			new Setting(containerEl)
				.setName('字段映射 JSON')
				.setDesc('将插件逻辑字段映射到多维表格字段名。留空使用默认字段名。')
				.addTextArea(text => text
					.setPlaceholder('例如：{\n  "title": "标题",\n  "content": "正文",\n  "link": "飞书链接"\n}')
					.setValue(this.plugin.settings.bitableFieldMapping || '')
					.onChange(async (value: string) => {
						this.plugin.settings.bitableFieldMapping = value;
						await this.plugin.saveSettings();
					}));
			this.renderBitableFieldMappingHint(containerEl);
			this.renderBitableFieldMappingAssistant(containerEl);
		}



	}

	private renderBitableTableAssistant(containerEl: HTMLElement): void {
		const panel = containerEl.createDiv({ cls: 'bitable-field-mapping-panel' });
		const toolbar = panel.createDiv({ cls: 'bitable-field-mapping-toolbar' });
		toolbar.createDiv({ text: '数据表选择助手', cls: 'bitable-field-mapping-title' });
		const actions = toolbar.createDiv({ cls: 'bitable-field-mapping-actions' });
		const loadButton = actions.createEl('button', { text: '读取数据表' });
		const hint = panel.createDiv({ cls: 'bitable-field-mapping-hint' });
		const tables = this.getCachedBitableTableOptions();
		const currentTableId = String(this.plugin.settings.bitableTableId || '').trim();

		const renderTableSelect = (target: HTMLElement, options: BitableTableOption[]) => {
			const grid = target.createDiv({ cls: 'bitable-field-mapping-grid' });
			grid.createDiv({ text: '选择数据表', cls: 'bitable-field-mapping-label' });
			const select = grid.createEl('select', { cls: 'bitable-field-mapping-select' });
			select.createEl('option', { text: '保留手动填写的 Table ID', value: '' });
			for (const option of options) {
				const label = option.name ? `${option.name} (${option.tableId})` : option.tableId;
				select.createEl('option', { text: label, value: option.tableId });
			}
			if (currentTableId && options.some((option) => option.tableId === currentTableId)) {
				select.value = currentTableId;
			}
			select.addEventListener('change', async () => {
				const next = String(select.value || '').trim();
				if (next && next !== this.plugin.settings.bitableTableId) {
					this.plugin.settings.bitableTableId = next;
					this.plugin.settings.bitableFieldNamesCache = [];
					await this.plugin.saveSettings();
					this.display();
				}
			});
		};

		if (!tables.length) {
			hint.setText('先填写或粘贴 App Token，再点击“读取数据表”。若读取失败，仍可手动填写 Table ID。');
		} else {
			renderTableSelect(panel, tables);
			hint.setText(`已读取 ${tables.length} 张数据表${currentTableId ? `；当前 Table ID：${currentTableId}` : ''}`);
		}

		loadButton.onclick = async () => {
			try {
				if (!this.plugin.settings.bitableAppToken) {
					new Notice('❌ 请先填写 Bitable App Token');
					return;
				}
				loadButton.disabled = true;
				loadButton.textContent = '读取中...';
				const result = await this.plugin.feishuApi.getBitableTables(this.plugin.settings.bitableAppToken);
				if (!result.success || !result.tables) {
					new Notice(`❌ 读取数据表失败：${result.error || '未知错误'}`);
					return;
				}
				this.setCachedBitableTableOptions(result.tables);
				if (!this.plugin.settings.bitableTableId && result.tables.length === 1) {
					this.plugin.settings.bitableTableId = result.tables[0].tableId;
				}
				await this.plugin.saveSettings();
				new Notice(`✅ 已读取 ${result.tables.length} 张数据表`);
				this.display();
			} catch (error) {
				new Notice(`❌ 读取数据表失败：${(error as Error).message}`);
			} finally {
				loadButton.disabled = false;
				loadButton.textContent = '读取数据表';
			}
		};
	}

	private renderBitableFieldMappingHint(containerEl: HTMLElement): void {
		const raw = String(this.plugin.settings.bitableFieldMapping || '').trim();
		const hint = containerEl.createDiv({ cls: 'setting-item-description' });
		hint.style.marginTop = '-8px';
		hint.style.marginBottom = '10px';
		if (!raw) {
			hint.setText('当前使用默认字段名：title、content、status、link、created、updated、tags、excerpt、author、aliases、slug、folder、value、recordId。');
			return;
		}
		try {
			const parsed = JSON.parse(raw);
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
				throw new Error('必须是 JSON 对象');
			}
			const count = Object.entries(parsed).filter(([key, value]) => String(key || '').trim() && String(value || '').trim()).length;
			hint.setText(`字段映射有效：${count} 项。`);
		} catch (error) {
			hint.setText(`字段映射 JSON 格式错误：${(error as Error).message}`);
			hint.addClass('mod-warning');
		}
	}

	private renderBitableFieldMappingAssistant(containerEl: HTMLElement): void {
		const panel = containerEl.createDiv({ cls: 'bitable-field-mapping-panel' });
		const toolbar = panel.createDiv({ cls: 'bitable-field-mapping-toolbar' });
		toolbar.createDiv({ text: '字段映射助手', cls: 'bitable-field-mapping-title' });
		const actions = toolbar.createDiv({ cls: 'bitable-field-mapping-actions' });
		const loadButton = actions.createEl('button', { text: '读取表格字段' });
		const resetButton = actions.createEl('button', { text: '清空映射' });
		const hint = panel.createDiv({ cls: 'bitable-field-mapping-hint' });

		const parseMapping = (): Record<string, string> => {
			const raw = String(this.plugin.settings.bitableFieldMapping || '').trim();
			if (!raw) return {};
			try {
				const parsed = JSON.parse(raw);
				if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
					return {};
				}
				return Object.fromEntries(
					Object.entries(parsed)
						.map(([key, value]) => [String(key || '').trim(), String(value || '').trim()])
						.filter(([key, value]) => key && value)
				);
			} catch {
				return {};
			}
		};

		const saveMapping = async (mapping: Record<string, string>) => {
			this.plugin.settings.bitableFieldMapping = Object.keys(mapping).length > 0
				? JSON.stringify(mapping, null, 2)
				: '';
			await this.plugin.saveSettings();
			this.display();
		};

		const currentFields = this.getCachedBitableFieldNames();
		if (!currentFields.length) {
			hint.setText('先点击“读取表格字段”，再用下拉框为 title、content、link 等逻辑字段选择对应的多维表格字段。');
		} else {
			this.renderBitableFieldMappingRows(panel, currentFields, parseMapping, saveMapping);
			hint.setText(`已读取 ${currentFields.length} 个表格字段。`);
		}

		loadButton.onclick = async () => {
			try {
				if (!this.plugin.settings.bitableAppToken || !this.plugin.settings.bitableTableId) {
					new Notice('❌ 请先填写 Bitable App Token 和 Table ID');
					return;
				}
				loadButton.disabled = true;
				loadButton.textContent = '读取中...';
				const result = await this.plugin.feishuApi.getBitableTableFields(
					this.plugin.settings.bitableAppToken,
					this.plugin.settings.bitableTableId
				);
				if (!result.success || !result.fields) {
					new Notice(`❌ 读取字段失败：${result.error || '未知错误'}`);
					return;
				}
				const names = result.fields.map((field) => field.name).filter((name) => !!name);
				this.setCachedBitableFieldNames(names);
				await this.plugin.saveSettings();
				new Notice(`✅ 已读取 ${names.length} 个表格字段`);
				this.display();
			} catch (error) {
				new Notice(`❌ 读取字段失败：${(error as Error).message}`);
			} finally {
				loadButton.disabled = false;
				loadButton.textContent = '读取表格字段';
			}
		};

		resetButton.onclick = async () => {
			await saveMapping({});
		};
	}

	private renderBitableFieldMappingRows(
		containerEl: HTMLElement,
		fieldNames: string[],
		parseMapping: () => Record<string, string>,
		saveMapping: (mapping: Record<string, string>) => Promise<void>
	): void {
		const logicalFields = [
			['title', '标题'],
			['content', '正文'],
			['link', '飞书链接'],
			['status', '状态'],
			['tags', '标签'],
			['excerpt', '摘要'],
			['author', '作者'],
			['aliases', '别名'],
			['created', '创建时间'],
			['updated', '更新时间'],
			['slug', '短名'],
			['folder', '文件夹'],
			['value', '本地路径'],
			['recordId', '记录 ID']
		];
		const grid = containerEl.createDiv({ cls: 'bitable-field-mapping-grid' });
		const mapping = parseMapping();
		for (const [logicalKey, label] of logicalFields) {
			grid.createDiv({ text: `${label} (${logicalKey})`, cls: 'bitable-field-mapping-label' });
			const select = grid.createEl('select', { cls: 'bitable-field-mapping-select' });
			select.createEl('option', { text: '不映射（使用默认字段名）', value: '' });
			for (const fieldName of fieldNames) {
				select.createEl('option', { text: fieldName, value: fieldName });
			}
			select.value = mapping[logicalKey] || '';
			select.addEventListener('change', async () => {
				const next = parseMapping();
				const value = select.value;
				if (value) {
					next[logicalKey] = value;
				} else {
					delete next[logicalKey];
				}
				await saveMapping(next);
			});
		}
	}

	private getCachedBitableFieldNames(): string[] {
		const raw = this.plugin.settings.bitableFieldNamesCache;
		return Array.isArray(raw) ? raw.map((name) => String(name)).filter((name) => !!name) : [];
	}

	private getCachedBitableTableOptions(): BitableTableOption[] {
		const raw = this.plugin.settings.bitableTableOptionsCache;
		return Array.isArray(raw)
			? raw
				.map((item) => ({
					tableId: String((item as BitableTableOption)?.tableId || '').trim(),
					name: String((item as BitableTableOption)?.name || '').trim(),
					revision: typeof (item as BitableTableOption)?.revision === 'number'
						? (item as BitableTableOption).revision
						: undefined
				}))
				.filter((item) => !!item.tableId)
			: [];
	}

	private setCachedBitableFieldNames(names: string[]): void {
		this.plugin.settings.bitableFieldNamesCache = [...new Set(names.map((name) => String(name).trim()).filter((name) => !!name))];
	}

	private setCachedBitableTableOptions(tables: BitableTableOption[]): void {
		this.plugin.settings.bitableTableOptionsCache = tables
			.map((item) => ({
				tableId: String(item?.tableId || '').trim(),
				name: String(item?.name || '').trim(),
				revision: typeof item?.revision === 'number' ? item.revision : undefined
			}))
			.filter((item) => !!item.tableId);
	}

	private describeScheduledSyncReport(report?: ScheduledSyncReport): string {
		if (!report || !report.status) {
			return '';
		}
		const statusMap: Record<string, string> = {
			idle: '未开始',
			running: '执行中',
			success: '成功',
			partial: '部分成功',
			failed: '失败',
			skipped: '已跳过',
			paused: '已暂停'
		};
		const parts = [`最近定时同步：${statusMap[report.status] || report.status}`];
		if (report.lastRunAt) {
			parts.push(`时间 ${new Date(report.lastRunAt).toLocaleString()}`);
		}
		if (typeof report.successCount === 'number' || typeof report.failedCount === 'number') {
			parts.push(`成功 ${report.successCount || 0}，失败 ${report.failedCount || 0}`);
		}
		if (report.failureStreak) {
			parts.push(`连续失败 ${report.failureStreak} 次`);
		}
		if (report.pauseUntil && report.pauseUntil > Date.now()) {
			parts.push(`恢复时间 ${new Date(report.pauseUntil).toLocaleString()}`);
		}
		if (report.message) {
			parts.push(report.message);
		}
		return parts.join(' | ');
	}

	private renderHistoryPanel(containerEl: HTMLElement): void {
		containerEl.createEl('h3', { text: '已上传文档列表' });
		const history = Array.isArray(this.plugin.settings.uploadHistory) ? this.plugin.settings.uploadHistory : [];
		if (history.length === 0) {
			containerEl.createEl('p', { text: '暂无上传记录', cls: 'upload-history-empty' });
			return;
		}
		const searchContainer = containerEl.createDiv({ cls: 'share-search-container' });
		const searchInput = searchContainer.createEl('input', {
			type: 'text',
			placeholder: '搜索标题或链接...',
			cls: 'share-search-input'
		});
		searchInput.value = this.historySearchQuery;
		searchInput.addEventListener('input', (e: Event) => {
			this.historySearchQuery = (e.target as HTMLInputElement).value;
			this.display();
		});
		const q = (this.historySearchQuery || '').trim().toLowerCase();
		const items = q
			? history.filter((h) => (h.title || '').toLowerCase().includes(q) || (h.url || '').toLowerCase().includes(q) || (h.docToken || '').toLowerCase().includes(q))
			: history;
		if (items.length === 0) {
			containerEl.createEl('p', { text: '没有找到匹配的记录', cls: 'upload-history-empty' });
			return;
		}

		this.renderHistoryBatchToolbar(containerEl, items);
		const list = containerEl.createDiv('upload-history-container');
		items.forEach((item) => {
			this.renderHistoryItem(list, item);
		});
	}

	private renderSyncStatusPanel(containerEl: HTMLElement): void {
		containerEl.createEl('h3', { text: '同步状态' });
		const states: SyncStateItem[] = Array.isArray(this.plugin.settings.syncStates) ? this.plugin.settings.syncStates : [];
		if (states.length === 0) {
			containerEl.createEl('p', { text: '暂无同步状态记录', cls: 'upload-history-empty' });
			return;
		}

		const counts = getSyncStatusCounts(states);
		this.renderSyncStatusSearch(containerEl);
		const filteredStates = searchSyncStates(filterSyncStates(states, this.syncStatusFilter), this.syncStatusSearchQuery);

		new Setting(containerEl)
			.setName('状态记录')
			.setDesc(`共 ${states.length} 条，需关注 ${counts.problem} 条，冲突 ${counts.conflict} 条，错误 ${counts.error} 条。用于判断本地/飞书是否有未同步改动。`)
			.addButton(btn => {
				btn
					.setButtonText('清空状态')
					.setWarning()
					.onClick(async () => {
						this.plugin.settings.syncStates = [];
						await this.plugin.saveSettings();
						new Notice('✅ 已清空同步状态');
						this.display();
					});
			});

		this.renderSyncStatusToolbar(containerEl, counts, filteredStates, states.length);
		const list = containerEl.createDiv('upload-history-container');
		const sorted = sortSyncStates(filteredStates);
		if (sorted.length === 0) {
			list.createEl('p', { text: this.syncStatusSearchQuery.trim() ? '没有找到匹配的同步状态记录' : '当前筛选下没有同步状态记录', cls: 'upload-history-empty' });
			return;
		}
		sorted.forEach((state) => this.renderSyncStatusItem(list, state));
	}

	private renderSyncStatusSearch(containerEl: HTMLElement): void {
		const searchContainer = containerEl.createDiv({ cls: 'share-search-container' });
		const searchInput = searchContainer.createEl('input', {
			type: 'text',
			placeholder: '搜索文件、链接、错误、建议或状态细节...',
			cls: 'share-search-input'
		});
		searchInput.value = this.syncStatusSearchQuery;
		searchInput.addEventListener('input', (e: Event) => {
			this.syncStatusSearchQuery = (e.target as HTMLInputElement).value;
			this.display();
		});
	}

	private renderSyncStatusToolbar(containerEl: HTMLElement, counts: SyncStatusCounts, visibleStates: SyncStateItem[], totalCount: number): void {
		const toolbar = containerEl.createDiv({ cls: 'sync-status-toolbar' });
		const filters = toolbar.createDiv({ cls: 'sync-status-filter-group' });
		const options: Array<{ key: SyncStatusFilter; label: string }> = [
			{ key: 'all', label: `全部 ${counts.all}` },
			{ key: 'problem', label: `需关注 ${counts.problem}` },
			{ key: 'conflict', label: `冲突 ${counts.conflict}` },
			{ key: 'error', label: `错误 ${counts.error}` },
			{ key: 'synced', label: `已同步 ${counts.synced}` }
		];
		options.forEach((option) => {
			const btn = filters.createEl('button', {
				text: option.label,
				cls: 'sync-status-filter-btn'
			});
			if (this.syncStatusFilter === option.key) {
				btn.addClass('is-active');
			}
			if (option.key !== 'all' && counts[option.key] === 0) {
				btn.addClass('is-empty');
			}
			btn.addEventListener('click', () => {
				this.syncStatusFilter = option.key;
				this.display();
			});
		});
		const actions = toolbar.createDiv({ cls: 'sync-status-filter-group' });
		const syncButton = actions.createEl('button', { text: '智能同步需关注项', cls: 'sync-status-filter-btn' });
		syncButton.setAttribute('title', '仅同步当前筛选中需要关注且本地文件存在的记录');
		const syncableStates = visibleStates.filter((state) => buildSyncStatusView(state).shouldAutoSync);
		if (syncableStates.length === 0) {
			syncButton.addClass('is-empty');
			syncButton.disabled = true;
		}
		syncButton.addEventListener('click', async () => {
			await this.smartSyncVisibleStates(syncableStates);
		});
		toolbar.createEl('span', {
			text: `当前显示 ${visibleStates.length}/${totalCount} 条`,
			cls: 'sync-status-summary'
		});
	}

	private async smartSyncVisibleStates(states: SyncStateItem[]): Promise<void> {
		if (states.length === 0) {
			new Notice(formatSyncBatchSummary({ total: 0, succeeded: 0, failed: 0 }));
			return;
		}
		const notice = new Notice(`正在智能同步 ${states.length} 个文件...`, 0);
		let succeeded = 0;
		const failedTitles: string[] = [];
		try {
			for (let i = 0; i < states.length; i++) {
				const state = states[i];
				notice.setMessage(`正在智能同步 ${i + 1}/${states.length}: ${state.title || state.filePath}`);
				try {
					const ok = await this.plugin.smartSyncFileByPath(state.filePath);
					if (ok) {
						succeeded += 1;
					} else {
						failedTitles.push(state.title || state.filePath || `第 ${i + 1} 项`);
					}
				} catch (e) {
					failedTitles.push(state.title || state.filePath || `第 ${i + 1} 项`);
					import('./debug').then(({ Debug }) => Debug.warn('Batch smart sync item failed:', e));
				}
			}
			notice.setMessage(formatSyncBatchSummary({
				total: states.length,
				succeeded,
				failed: failedTitles.length,
				failedTitles
			}));
			setTimeout(() => notice.hide(), 2500);
		} catch (e) {
			notice.hide();
			new Notice(`❌ 批量智能同步异常: ${(e as Error).message || String(e)}`);
		} finally {
			this.display();
		}
	}

	private renderSyncStatusItem(containerEl: HTMLElement, state: SyncStateItem): void {
		const view = buildSyncStatusView(state);
		const row = containerEl.createDiv('upload-history-item');
		const content = row.createDiv('upload-history-content');
		const header = content.createDiv('upload-history-header');
		header.createDiv({ text: view.title, cls: 'upload-history-title' });
		const meta = header.createDiv('upload-history-meta');
		const badge = meta.createDiv({ text: formatSyncStatus(view.status), cls: `sync-status-badge ${view.status}` });
		badge.setAttribute('title', view.status);
		if (view.lastSyncedAt) {
			meta.createDiv({ text: new Date(view.lastSyncedAt).toLocaleString(), cls: 'upload-history-time' });
		}
		const actions = meta.createDiv('upload-history-actions');
		this.renderSyncStatusActions(actions, state);

		content.createDiv({ text: view.summary, cls: 'sync-status-summary-line' });
		const recommendation = content.createDiv({ cls: `sync-status-recommendation ${view.recommendation.level}` });
		recommendation.createEl('span', { text: view.recommendation.label, cls: 'sync-status-recommendation-label' });
		recommendation.createEl('span', { text: view.recommendation.action });
		const detailRow = content.createDiv({ cls: 'sync-status-detail' });
		view.detailParts.forEach((part) => {
			const chip = detailRow.createDiv({ cls: `sync-status-detail-chip ${part.group}` });
			chip.createEl('span', { text: part.label, cls: 'sync-status-detail-label' });
			chip.createEl('span', { text: part.value });
		});

		if (view.url) {
			const linkRow = content.createDiv('upload-history-link-row');
			const linkEl = linkRow.createEl('a', { text: view.url, href: view.url, cls: 'upload-history-link' });
			linkEl.setAttribute('target', '_blank');
		}
	}

	private renderSyncStatusActions(containerEl: HTMLElement, state: SyncStateItem): void {
		const filePath = state && state.filePath ? String(state.filePath) : '';
		const view = buildSyncStatusView(state);
		const makeAction = (text: string, title: string, onClick: () => Promise<void>, disabled = false) => {
			const btn = containerEl.createEl('span', { text, cls: 'upload-history-action-btn' });
			btn.setAttribute('title', title);
			if (!filePath || disabled) {
				btn.style.opacity = '0.35';
				btn.style.cursor = 'not-allowed';
				return;
			}
			btn.onclick = async () => {
				try {
					await onClick();
					this.display();
				} catch (e) {
					new Notice(`❌ 操作失败: ${(e as Error).message || String(e)}`);
				}
			};
		};
		makeAction('🔄', '智能同步', async () => {
			await this.plugin.smartSyncFileByPath(filePath);
		}, !view.canSync);
		makeAction('⬇️', '从飞书拉取覆盖本地', async () => {
			await this.plugin.pullFromFeishuByPath(filePath);
		}, !view.canSync);
		makeAction('⬆️', '推送本地覆盖飞书', async () => {
			await this.plugin.pushToFeishuByPath(filePath);
		}, !view.canSync);
		makeAction('📊', '从多维表格更新本地', async () => {
			await this.plugin.pullFromBitableByPath(filePath);
		}, !view.canSync);
		if (state.localMissing) {
			makeAction('✕', '清理本地映射（不删除飞书内容）', async () => {
				if (!confirm(`确定清理「${state.title || state.filePath}」的本地同步映射吗？\n\n这不会删除飞书文档或多维表格记录。`)) {
					return;
				}
				await this.plugin.removeMappingByFilePath(filePath);
				new Notice('✅ 已清理本地同步映射');
			});
		}
	}

	private renderHistoryBatchToolbar(containerEl: HTMLElement, items: any[]): void {
		const toolbar = containerEl.createDiv({ cls: 'share-batch-toolbar' });
		const leftActions = toolbar.createDiv({ cls: 'share-batch-left' });
		const checkbox = leftActions.createEl('input', {
			type: 'checkbox',
			cls: 'share-select-all'
		});
		const allDocTokens = items.map((it) => it && it.docToken).filter((t) => !!t);
		checkbox.checked = allDocTokens.length > 0 && allDocTokens.every((t) => this.selectedHistoryDocTokens.has(String(t)));
		checkbox.addEventListener('change', () => {
			if (checkbox.checked) {
				allDocTokens.forEach((t) => this.selectedHistoryDocTokens.add(String(t)));
			} else {
				allDocTokens.forEach((t) => this.selectedHistoryDocTokens.delete(String(t)));
			}
			this.display();
		});
		leftActions.createEl('span', { text: `全选（已选 ${this.selectedHistoryDocTokens.size} 个）`, cls: 'share-select-label' });

		if (this.selectedHistoryDocTokens.size > 0) {
			const rightActions = toolbar.createDiv({ cls: 'share-batch-right' });
			const batchPermButton = rightActions.createEl('button', { text: '批量设置权限', cls: 'mod-cta' });
			batchPermButton.addEventListener('click', async () => {
				await this.batchSetPermissions();
			});
			const batchDeleteButton = rightActions.createEl('button', { text: '批量删除', cls: 'mod-warning' });
			batchDeleteButton.addEventListener('click', async () => {
				await this.batchDeleteItems();
			});
		}
	}

	private renderHistoryItem(containerEl: HTMLElement, item: any): void {
		const row = containerEl.createDiv('upload-history-item');
		const checkbox = row.createEl('input', { type: 'checkbox', cls: 'share-item-checkbox' });
		const token = item && item.docToken ? String(item.docToken) : '';
		checkbox.checked = !!token && this.selectedHistoryDocTokens.has(token);
		checkbox.addEventListener('change', () => {
			if (!token) return;
			if (checkbox.checked) {
				this.selectedHistoryDocTokens.add(token);
			} else {
				this.selectedHistoryDocTokens.delete(token);
			}
			this.display();
		});

		const content = row.createDiv('upload-history-content');
		const header = content.createDiv('upload-history-header');
		header.createDiv({ text: item.title || item.filePath || item.docToken, cls: 'upload-history-title' });
		const meta = header.createDiv('upload-history-meta');
		if (item.localDeletedAt) {
			const deletedBadge = meta.createDiv({ text: '本地已删除', cls: 'sync-status-badge error' });
			deletedBadge.setAttribute('title', new Date(item.localDeletedAt).toLocaleString());
		}
		if (item.updatedAt) {
			const t = new Date(item.updatedAt);
			meta.createDiv({ text: `${t.toLocaleString()}`, cls: 'upload-history-time' });
		}
		const actions = meta.createDiv('upload-history-actions');
		const url = item.url || (item.docToken ? `https://feishu.cn/docx/${item.docToken}` : '');
		const linkRow = content.createDiv('upload-history-link-row');
		const linkEl = linkRow.createEl('a', { text: url, href: url, cls: 'upload-history-link' });
		linkEl.setAttribute('target', '_blank');

		const copyBtn = actions.createEl('span', { text: '📋', cls: 'upload-history-action-btn' });
		copyBtn.setAttribute('title', '复制链接');
		copyBtn.onclick = () => {
			try {
				navigator.clipboard.writeText(url);
				new Notice('链接已复制到剪贴板');
			} catch {
			}
		};

		const permBtn = actions.createEl('span', { text: '⚙️', cls: 'upload-history-action-btn' });
		permBtn.setAttribute('title', '设置权限');
		permBtn.onclick = async () => {
			if (!token) {
				new Notice('❌ docToken 缺失，无法设置权限');
				return;
			}
			new PermissionModal(this.app, this.plugin, {
				title: '设置文档权限',
				description: `为文档“${item.title || item.filePath || token}”设置访问权限`,
				loadCurrent: async () => {
					const p = await this.plugin.feishuApi.getDocumentPermissions(token);
					const linkShareEntity = p && p.link_share_entity ? String(p.link_share_entity) : '';
					if (!linkShareEntity || linkShareEntity === 'close') {
						return { enableLinkShare: false, linkSharePermission: 'tenant_readable' as const };
					}
					if (linkShareEntity === 'tenant_readable' || linkShareEntity === 'tenant_editable' || linkShareEntity === 'anyone_readable' || linkShareEntity === 'anyone_editable') {
						return { enableLinkShare: true, linkSharePermission: linkShareEntity as any };
					}
					return { enableLinkShare: true, linkSharePermission: 'tenant_readable' as const };
				},
				onSubmit: async (enableLinkShare, linkSharePermission) => {
					await this.plugin.feishuApi.setDocumentSharePermissionsExplicit({
						documentToken: token,
						enableLinkShare,
						linkSharePermission,
						skipPermissionCheck: true
					});
					new Notice('✅ 权限已更新');
					this.display();
				}
			}).open();
		};

		const deleteBtn = actions.createEl('span', { text: '🗑️', cls: 'upload-history-action-btn' });
		deleteBtn.setAttribute('title', '删除云端文档');
		deleteBtn.onclick = async () => {
			if (!token) {
				new Notice('❌ docToken 缺失，无法删除文档');
				return;
			}
			const confirmed = confirm('确定要删除该条记录对应的飞书云端文档吗？\n\n注意：此操作将删除飞书云端文档，并移除本地映射。');
			if (!confirmed) return;
			try {
				try {
					await this.plugin.feishuApi.deleteDocument(token);
				} catch (e) {
					if (!this.isNotFoundError(e) && !this.isTokenInvalidDeleteError(e)) {
						throw e;
					}
				}
				await this.tryDeleteBitableForHistoryToken(token);
				await this.deleteHistoryItem(token);
				this.selectedHistoryDocTokens.delete(token);
				this.display();
				new Notice('✅ 已移除映射');
			} catch (e) {
				import('./debug').then(({ Debug }) => Debug.error('Delete document failed:', e));
				new Notice(`❌ 删除失败: ${(e as Error).message || String(e)}`);
			}
		};
	}

	private async tryDeleteBitableForHistoryToken(docToken: string): Promise<void> {
		try {
			const appToken = this.plugin.settings.bitableAppToken;
			const tableId = this.plugin.settings.bitableTableId;
			if (!appToken || !tableId) {
				return;
			}
			const history = Array.isArray(this.plugin.settings.uploadHistory) ? this.plugin.settings.uploadHistory : [];
			const it = history.find((h) => h && String(h.docToken) === String(docToken));
			if (!it) {
				return;
			}

			const directRecordId = it.bitableRecordId ? String(it.bitableRecordId) : '';
			if (directRecordId) {
				await this.plugin.feishuApi.deleteBitableRecord(appToken, tableId, directRecordId);
				return;
			}

			const url = it.url || (it.docToken ? `https://feishu.cn/docx/${it.docToken}` : '');
			if (!url) {
				return;
			}
			const rid = await this.plugin.feishuApi.findBitableRecordIdByLink(appToken, tableId, url);
			if (!rid) {
				return;
			}
			await this.plugin.feishuApi.deleteBitableRecord(appToken, tableId, rid);
		} catch {
			return;
		}
	}

	private async deleteHistoryItem(docToken: string): Promise<void> {
		await this.plugin.removeMappingByDocToken(docToken);
	}

	private async batchSetPermissions(): Promise<void> {
		if (this.selectedHistoryDocTokens.size === 0) {
			new Notice('❌ 请先选择要设置的文档');
			return;
		}
		const tokens = Array.from(this.selectedHistoryDocTokens);
		new PermissionModal(this.app, this.plugin, {
			title: '批量设置权限',
			description: `将以下设置应用到所选 ${tokens.length} 个文档`,
			onSubmit: async (enableLinkShare, linkSharePermission) => {
				const notice = this.plugin.settings.suppressShareNotices ? undefined : new Notice(`🔗 正在设置权限(0/${tokens.length})...`, 0);
				try {
					for (let i = 0; i < tokens.length; i++) {
						notice?.setMessage(`🔗 正在设置权限(${i + 1}/${tokens.length})...`);
						await this.plugin.feishuApi.setDocumentSharePermissionsExplicit({
							documentToken: tokens[i],
							enableLinkShare,
							linkSharePermission,
							skipPermissionCheck: true
						});
					}
					new Notice('✅ 批量设置权限完成');
				} catch (e) {
					new Notice(`❌ 批量设置权限失败: ${(e as Error).message || String(e)}`);
				} finally {
					notice?.hide();
					this.selectedHistoryDocTokens.clear();
					this.display();
				}
			}
		}).open();
	}

	private async batchDeleteItems(): Promise<void> {
		if (this.selectedHistoryDocTokens.size === 0) {
			new Notice('❌ 请先选择要删除的文档');
			return;
		}
		const confirmed = confirm(`确定要批量删除 ${this.selectedHistoryDocTokens.size} 个文档吗？\n\n注意：此操作将删除飞书云端文档，并移除本地映射。`);
		if (!confirmed) return;
		const tokens = Array.from(this.selectedHistoryDocTokens);
		const notice = this.plugin.settings.suppressShareNotices ? undefined : new Notice(`🗑️ 正在删除(0/${tokens.length})...`, 0);
		try {
			for (let i = 0; i < tokens.length; i++) {
				notice?.setMessage(`🗑️ 正在删除(${i + 1}/${tokens.length})...`);
				try {
					await this.plugin.feishuApi.deleteDocument(tokens[i]);
				} catch (e) {
					if (!this.isNotFoundError(e) && !this.isTokenInvalidDeleteError(e)) {
						throw e;
					}
				}
				await this.tryDeleteBitableForHistoryToken(tokens[i]);
				await this.deleteHistoryItem(tokens[i]);
			}
			new Notice('✅ 批量删除完成');
		} catch (e) {
			new Notice(`❌ 批量删除失败: ${(e as Error).message || String(e)}`);
		} finally {
			notice?.hide();
			this.selectedHistoryDocTokens.clear();
			this.display();
		}
	}

private startAutoAuth() {
		if (!this.plugin.settings.appId || !this.plugin.settings.appSecret) {
			new Notice('❌ 请先配置 App ID 和 App Secret');
			import('./debug').then(({ Debug }) => Debug.error('Missing App ID or App Secret'));
			return;
		}

		// 确保API服务有最新的设置
		this.plugin.feishuApi.updateSettings(this.plugin.settings);
		try {
			// 生成授权URL并打开浏览器
			const authUrl = this.plugin.feishuApi.generateAuthUrl();
			// 打开浏览器进行授权
			window.open(authUrl, '_blank');

			new Notice('🔄 已打开浏览器进行授权，完成后将自动返回Obsidian');

			// 监听授权成功事件
			const successHandler = async () => {
				try {
					// 授权回调完成后：自动拉取用户信息并持久化，避免需要手动刷新/重启
					this.plugin.feishuApi.updateSettings(this.plugin.settings);
					const userInfo = await this.plugin.feishuApi.getUserInfo();
					if (userInfo) {
						this.plugin.settings.userInfo = userInfo;
						await this.plugin.saveSettings();
					}
				} catch (e) {
					import('./debug').then(({ Debug }) => Debug.error('Failed to fetch user info after auth:', e));
				} finally {
					this.display(); // 刷新设置界面
					window.removeEventListener('feishu-auth-success', successHandler);
				}
			};

			window.addEventListener('feishu-auth-success', successHandler);

		} catch (error) {
			import('./debug').then(({ Debug }) => Debug.error('Auto auth error:', error));
			new Notice(`❌ 自动授权失败: ${error.message}`);
		}
	}

	private startManualAuth(): void {
		if (!this.plugin.settings.appId || !this.plugin.settings.appSecret) {
			new Notice('❌ 请先配置 App ID 和 App Secret');
			return;
		}

		try {
			// 确保API服务有最新的设置
			this.plugin.feishuApi.updateSettings(this.plugin.settings);
			const modal = new ManualAuthModal(
				this.app,
				this.plugin.feishuApi,
				async () => {
					// 授权成功回调
					await this.plugin.saveSettings();
					this.display(); // 刷新设置界面
				}
			);
			modal.open();
		} catch (error) {
			import('./debug').then(({ Debug }) => Debug.error('[Feishu Plugin] Failed to start manual auth:', error));
			new Notice('❌ 启动授权失败，请重试');
		}
	}

	/**
	 * 显示文件夹选择模态框
	 */
	private showFolderSelectModal(): void {
		try {
			// 授权前置校验
			if (!this.plugin.settings.accessToken || !this.plugin.settings.userInfo) {
				new Notice('❌ 请先在设置中完成飞书授权');
				return;
			}
			const modal = new FolderSelectModal(
				this.app,
				this.plugin.feishuApi,
				async (selectedFolder) => {
					try {
						if (selectedFolder) {
							// 用户选择了一个文件夹
							// 兼容两种属性名：folder_token 和 token
							this.plugin.settings.defaultFolderId = selectedFolder.folder_token || selectedFolder.token || '';
							this.plugin.settings.defaultFolderName = selectedFolder.name;
						} else {
							// 用户选择了根目录（我的空间）
							import('./debug').then(({ Debug }) => Debug.log('[Feishu Plugin] Root folder selected (我的空间)'));
							this.plugin.settings.defaultFolderId = '';
							this.plugin.settings.defaultFolderName = '我的空间';
						}

						await this.plugin.saveSettings();
						new Notice('✅ 默认文件夹设置已保存');
						this.display(); // 刷新设置界面
					} catch (error) {
						import('./debug').then(({ Debug }) => Debug.error('[Feishu Plugin] Failed to save folder settings:', error));
						new Notice('❌ 保存文件夹设置失败');
					}
				}
			);

			modal.open();
		} catch (error) {
			import('./debug').then(({ Debug }) => Debug.error('[Feishu Plugin] Failed to open folder selection modal:', error));
			new Notice('❌ 打开文件夹选择失败');
		}
	}

	/**
	 * 添加云空间设置
	 */
	private addDriveSettings(containerEl: HTMLElement) {
		if (!this.plugin.settings.userInfo) return;

		containerEl.createEl('h4', { text: '📁 云空间文件夹设置' });

		// 当前默认文件夹显示
		new Setting(containerEl)
			.setName('当前默认文件夹')
			.setDesc(`文档将保存到：${this.plugin.settings.defaultFolderName || '我的空间'}${this.plugin.settings.defaultFolderId ? ` (ID: ${this.plugin.settings.defaultFolderId})` : ''}`)
			.addButton(button => {
				button
					.setButtonText('📁 选择文件夹')
					.onClick(() => {
						this.showFolderSelectModal();
					});
			});
	}

	/**
	 * 添加知识库设置
	 */
	private addWikiSettings(containerEl: HTMLElement) {
		if (!this.plugin.settings.userInfo) return;

		containerEl.createEl('h4', { text: '📚 知识库设置' });

		// 当前知识库位置显示
		const currentLocation = this.getWikiLocationDescription();
		new Setting(containerEl)
			.setName('当前知识库位置')
			.setDesc(`文档将保存到：${currentLocation}`)
			.addButton(button => {
				button
					.setButtonText('📚 选择知识库位置')
					.onClick(() => {
						this.showWikiSelectModal();
					});
			});
	}

	/**
	 * 获取知识库位置描述
	 */
	private getWikiLocationDescription(): string {
		const spaceName = this.plugin.settings.defaultWikiSpaceName || '未选择知识库';
		const nodeName = this.plugin.settings.defaultWikiNodeName;

		if (nodeName) {
			return `${spaceName} / ${nodeName}`;
		} else {
			return `${spaceName} (根目录)`;
		}
	}

	/**
	 * 显示知识库选择模态框
	 */
	private async showWikiSelectModal() {
		try {
			// 授权前置校验
			if (!this.plugin.settings.accessToken || !this.plugin.settings.userInfo) {
				new Notice('❌ 请先在设置中完成飞书授权');
				return;
			}
			const modal = new WikiSelectModal(
				this.app,
				this.plugin.feishuApi,
				async (space, node) => {
					if (space) {
						this.plugin.settings.defaultWikiSpaceId = space.space_id;
						this.plugin.settings.defaultWikiSpaceName = space.name;

						if (node) {
							this.plugin.settings.defaultWikiNodeToken = node.node_token;
							this.plugin.settings.defaultWikiNodeName = node.title;
						} else {
							this.plugin.settings.defaultWikiNodeToken = '';
							this.plugin.settings.defaultWikiNodeName = '';
						}

						await this.plugin.saveSettings();
						this.plugin.feishuApi.updateSettings(this.plugin.settings);
						new Notice('✅ 知识库位置已更新');
						this.display(); // 刷新界面
					}
				}
			);

			modal.open();
		} catch (error) {
			import('./debug').then(({ Debug }) => Debug.error('[Feishu Plugin] Failed to open wiki selection modal:', error));
			new Notice('❌ 打开知识库选择失败');
		}
	}
}


class PermissionModal extends Modal {
	private plugin: FeishuPlugin;
	private titleText: string;
	private descriptionText: string;
	private onSubmit: (enableLinkShare: boolean, linkSharePermission: 'anyone_readable' | 'anyone_editable' | 'tenant_readable' | 'tenant_editable') => Promise<void>;
	private loadCurrent?: () => Promise<{ enableLinkShare: boolean; linkSharePermission: 'anyone_readable' | 'anyone_editable' | 'tenant_readable' | 'tenant_editable' }>;
	private enableLinkShare: boolean = true;
	private linkSharePermission: 'anyone_readable' | 'anyone_editable' | 'tenant_readable' | 'tenant_editable' = 'tenant_readable';
	private loadingEl?: HTMLElement;

	constructor(app: App, plugin: FeishuPlugin, opts: { title: string; description: string; onSubmit: (enableLinkShare: boolean, linkSharePermission: 'anyone_readable' | 'anyone_editable' | 'tenant_readable' | 'tenant_editable') => Promise<void>; loadCurrent?: () => Promise<{ enableLinkShare: boolean; linkSharePermission: 'anyone_readable' | 'anyone_editable' | 'tenant_readable' | 'tenant_editable' }> }) {
		super(app);
		this.plugin = plugin;
		this.titleText = opts.title;
		this.descriptionText = opts.description;
		this.onSubmit = opts.onSubmit;
		this.loadCurrent = opts.loadCurrent;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		const modalRoot = contentEl.closest('.modal');
		if (modalRoot) {
			modalRoot.classList.add('feishu-permission-modal-wrapper');
		}
		contentEl.addClass('feishu-permission-modal');
		contentEl.createEl('style', {
			text: `
				.feishu-permission-modal-wrapper {
					width: fit-content;
					min-width: unset;
					max-width: calc(100% - 40px);
					height: fit-content !important;
					min-height: unset !important;
					max-height: calc(100% - 40px);
					padding: 0;
					margin: 0;
				}
				.feishu-permission-modal-wrapper .modal-close-button {
					right: 26px !important;
				}
				.feishu-permission-modal-wrapper .modal-content {
					padding: 22px 26px 8px;
					margin: 0;
					display: inline-block;
					width: fit-content;
					height: auto !important;
					min-height: unset !important;
					max-height: unset !important;
				}
				.feishu-permission-modal {
					padding: 0;
				}
				.feishu-permission-modal h2 {
					margin: 0 0 6px;
					font-size: 18px;
					font-weight: 500;
				}
				.feishu-permission-modal .setting-item-description {
					margin: 0 0 20px;
					color: var(--text-muted);
					font-size: 13px;
					white-space: normal;
				}
				.feishu-permission-actions {
					display: flex;
					gap: 10px;
					justify-content: flex-end;
					margin-left: 84px;
					width: calc(100% - 84px);
					margin-top: 14px;
					margin-bottom: 0;
				}
				.feishu-permission-row {
					display: flex;
					gap: 12px;
					align-items: center;
					justify-content: flex-start;
					margin-top: 12px;
				}
				.feishu-permission-row label {
					min-width: 72px;
					font-size: 14px;
					color: var(--text-normal);
					flex-shrink: 0;
				}
				.feishu-permission-select {
					width: auto;
					max-width: min(90vw, 520px);
					font-size: 14px;
				}
				.feishu-permission-actions button {
					min-width: 88px;
					padding: 6px 16px;
					font-size: 14px;
				}
				.feishu-toggle {
					width: 36px;
					height: 20px;
					border-radius: 10px;
					background: var(--background-modifier-border);
					cursor: pointer;
					transition: background 0.2s;
					flex-shrink: 0;
					position: relative;
				}
				.feishu-toggle.is-on {
					background: var(--interactive-accent);
				}
				.feishu-toggle-thumb {
					position: absolute;
					top: 3px;
					left: 3px;
					width: 14px;
					height: 14px;
					border-radius: 50%;
					background: #fff;
					transition: transform 0.2s;
				}
				.feishu-toggle.is-on .feishu-toggle-thumb {
					transform: translateX(16px);
				}
			`
		});

		contentEl.createEl('h2', { text: this.titleText });
		contentEl.createDiv({ text: this.descriptionText, cls: 'setting-item-description' });
		if (this.loadCurrent) {
			this.loadingEl = contentEl.createDiv({ text: '正在读取当前权限...', cls: 'setting-item-description' });
		}

		const enableRow = contentEl.createDiv({ cls: 'feishu-permission-row' });
		enableRow.createEl('label', { text: '开启分享' });
		const toggle = enableRow.createDiv({ cls: `feishu-toggle${this.enableLinkShare ? ' is-on' : ''}` });
		toggle.createDiv({ cls: 'feishu-toggle-thumb' });
		toggle.addEventListener('click', () => {
			this.enableLinkShare = !this.enableLinkShare;
			toggle.classList.toggle('is-on', this.enableLinkShare);
			permSelect.disabled = !this.enableLinkShare;
		});

		const permRow = contentEl.createDiv({ cls: 'feishu-permission-row' });
		permRow.createEl('label', { text: '权限类型' });
		const permSelect = permRow.createEl('select', { cls: 'feishu-permission-select' });
		type PermissionType = 'anyone_readable' | 'anyone_editable' | 'tenant_readable' | 'tenant_editable';
		const addOption = (value: PermissionType, label: string) => {
			const opt = permSelect.createEl('option', { text: label });
			opt.value = value;
		};
		addOption('tenant_readable', '🏢 组织内获得链接的人可阅读');
		addOption('tenant_editable', '🏢 组织内获得链接的人可编辑');
		addOption('anyone_readable', '🌐 互联网上获得链接的任何人可阅读');
		addOption('anyone_editable', '🌐 互联网上获得链接的任何人可编辑');
		permSelect.value = this.linkSharePermission;
		permSelect.disabled = !this.enableLinkShare;
		// 根据最长选项动态计算下拉框宽度，让弹窗整体宽度贴合内容
		requestAnimationFrame(() => {
			try {
				const options = Array.from(permSelect.options) as HTMLOptionElement[];
				const longest = options.reduce((acc: string, opt: HTMLOptionElement) => (opt.text.length > acc.length ? opt.text : acc), '');
				const probe = document.createElement('span');
				probe.style.position = 'absolute';
				probe.style.visibility = 'hidden';
				probe.style.whiteSpace = 'nowrap';
				const cs = window.getComputedStyle(permSelect);
				probe.style.font = cs.font;
				probe.textContent = longest;
				document.body.appendChild(probe);
				const textWidth = probe.getBoundingClientRect().width;
				probe.remove();
				const extra = 64; // 左侧图标/内边距/下拉箭头的保守预留
				const targetWidth = Math.min(Math.max(260, Math.ceil(textWidth + extra)), 520);
				permSelect.style.width = `${targetWidth}px`;
			} catch {
				// 忽略测量失败，保持默认
			}
		});
		permSelect.addEventListener('change', () => {
			this.linkSharePermission = permSelect.value as PermissionType;
		});

		if (this.loadCurrent) {
			void this.loadCurrent().then((v) => {
				this.enableLinkShare = v.enableLinkShare;
				this.linkSharePermission = v.linkSharePermission;
				toggle.classList.toggle('is-on', this.enableLinkShare);
				permSelect.value = this.linkSharePermission;
				permSelect.disabled = !this.enableLinkShare;
				this.loadingEl?.remove();
			}).catch(() => {
				this.loadingEl?.setText('读取当前权限失败，可直接选择后提交');
			});
		}

		const actions = contentEl.createDiv({ cls: 'feishu-permission-actions' });
		const cancelBtn = actions.createEl('button', { text: '取消' });
		const submitBtn = actions.createEl('button', { text: '提交设置', cls: 'mod-cta' });
		submitBtn.onclick = async () => {
			await this.onSubmit(this.enableLinkShare, this.linkSharePermission);
			this.close();
		};
		cancelBtn.onclick = () => this.close();
	}
}
