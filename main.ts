import { Plugin, Notice, TFile, Menu, Editor, MarkdownView, Modal, normalizePath } from 'obsidian';
import { BitableSyncProfile, FeishuSettings, ShareResult, SyncDirection, SyncTarget, ScheduledSyncScope, ScheduledSyncReport } from './src/types';
import { DEFAULT_SETTINGS, SUCCESS_NOTICE_TEMPLATE } from './src/constants';
import { FeishuApiService } from './src/feishu-api';
import { FeishuSettingTab } from './src/settings';
import { MarkdownProcessor } from './src/markdown-processor';
import { Debug } from './src/debug';
import { DocxBlocksToMarkdown } from './src/docx-blocks-to-markdown';
import { isRemoteUpdatedAfterLocal, SyncStateService } from './src/sync-state';
import { planSmartSyncBoth } from './src/smart-sync-plan';
import { bitableFieldToFrontMatterValue, bitableFieldToPlainText, normalizeBitableWriteValue } from './src/bitable-fields';
import {
	applyProfileRecordToMarkdown,
	buildProfileBitableFieldsFromMarkdown,
	buildProfileManagedContent,
	buildProfileMarkdownFromRecord,
	buildProfileRemoteManagedContent,
	DEFAULT_IOTO_TASK_PROFILE,
	getProfileRecordIdFromMarkdown,
	mergeDefaultBitableProfiles,
	renderProfileFileName,
	resolveProfileFieldName,
	selectBitableProfileForFile,
	selectScheduledBitableProfiles
} from './src/bitable-profile';

type ShareFileOptions = {
	forceUpdateUrl?: string;
	syncTargetOverride?: SyncTarget;
	silent?: boolean;
};

type SyncExecutionOptions = {
	interactive?: boolean;
	silent?: boolean;
	source?: 'manual' | 'scheduled';
	forceRemoteOverwrite?: boolean;
};

type SyncErrorExtra = {
	docToken?: string;
	url?: string;
	bitableRecordId?: string;
	remoteHash?: string;
	remoteRevision?: string;
	remoteUpdatedAt?: number;
	docRemoteRevision?: string;
	docRemoteUpdatedAt?: number;
	bitableRemoteHash?: string;
	bitableRemoteUpdatedAt?: number;
};

export default class FeishuPlugin extends Plugin {
	settings: FeishuSettings;
	feishuApi: FeishuApiService;
	markdownProcessor: MarkdownProcessor;
	syncState: SyncStateService;
	private scheduledSyncIntervalId: number | null = null;
	private scheduledSyncStartupTimeoutId: number | null = null;
	private scheduledSyncInProgress: boolean = false;
	private scheduledProfileIntervalIds: Map<string, number> = new Map();
	private scheduledProfileStartupTimeoutIds: Map<string, number> = new Map();
	private scheduledProfileInProgress: Set<string> = new Set();

	async onload(): Promise<void> {
		// 加载设置
		await this.loadSettings();

		// 初始化服务
		this.feishuApi = new FeishuApiService(this.settings, this.app);
		this.markdownProcessor = new MarkdownProcessor(this.app);
		this.syncState = new SyncStateService(this.settings);
		this.syncState.migrateFromHistory();

		// 注册自定义协议处理器，实现自动授权回调
		this.registerObsidianProtocolHandler('feishu-auth', (params: any) => {
			this.handleOAuthCallback(params);
		});
		this.registerObsidianProtocolHandler('feishu-share', (params: any) => {
			const action = String(params.action || '').trim();
			if (action === 'oauth-callback' || action === 'feishu-auth') {
				this.handleOAuthCallback(params);
			}
		});
		this.registerFileMappingEvents();

		// 添加设置页面
		this.addSettingTab(new FeishuSettingTab(this.app, this));

		// 添加功能区图标，直接触发当前笔记的智能双向同步
		this.addRibbonIcon('refresh-cw', '智能双向同步当前笔记', () => {
			this.smartSyncCurrentNote();
		});

		// 注册命令和菜单
		this.registerCommands();
		this.registerMenus();
		this.configureScheduledSync();
	}

	onunload(): void {
		this.clearScheduledSyncTimers();
	}

	private registerFileMappingEvents(): void {
		const vault = this.app.vault;
		if (!vault || typeof vault.on !== 'function') {
			return;
		}
		this.registerEvent(vault.on('rename', (file: TFile, oldPath: string) => {
			if (!file || file.extension !== 'md') {
				return;
			}
			this.migrateLocalMappingPath(oldPath, file.path, file.basename).catch((error) => {
				this.log(`Failed to migrate sync mapping after rename: ${this.getErrorMessage(error)}`, 'warn');
			});
		}));
		this.registerEvent(vault.on('delete', (file: TFile) => {
			if (!file || file.extension !== 'md') {
				return;
			}
			this.removeLocalMappingPath(file.path).catch((error) => {
				this.log(`Failed to remove sync mapping after delete: ${this.getErrorMessage(error)}`, 'warn');
			});
		}));
		this.registerEvent(vault.on('create', (file: TFile) => {
			if (!file || file.extension !== 'md') {
				return;
			}
			this.restoreLocalMappingPath(file.path, file.basename).catch((error) => {
				this.log(`Failed to restore sync mapping after create: ${this.getErrorMessage(error)}`, 'warn');
			});
		}));
	}

	private async migrateLocalMappingPath(oldPath: string, newPath: string, title?: string): Promise<void> {
		const from = String(oldPath || '').trim();
		const to = String(newPath || '').trim();
		if (!from || !to || from === to) {
			return;
		}
		let changed = false;
		const history = Array.isArray(this.settings.uploadHistory) ? this.settings.uploadHistory : [];
		const oldIdx = history.findIndex((item) => item && item.filePath === from);
		if (oldIdx >= 0) {
			const newIdx = history.findIndex((item, idx) => idx !== oldIdx && item && item.filePath === to);
			const moved = {
				...history[oldIdx],
				filePath: to,
				title: title || history[oldIdx].title,
				updatedAt: Date.now(),
				localDeletedAt: undefined
			};
			if (newIdx >= 0) {
				const merged = { ...history[newIdx], ...moved };
				delete (merged as any).localDeletedAt;
				history[newIdx] = merged;
				history.splice(oldIdx, 1);
			} else {
				delete (moved as any).localDeletedAt;
				history[oldIdx] = moved;
			}
			this.settings.uploadHistory = history;
			changed = true;
		}
		changed = this.syncState.renamePath(from, to, title) || changed;
		if (changed) {
			await this.saveSettings();
			this.log(`Sync mapping moved: ${from} -> ${to}`);
		}
	}

	private async removeLocalMappingPath(filePath: string): Promise<void> {
		const path = String(filePath || '').trim();
		if (!path) {
			return;
		}
		let changed = false;
		const history = Array.isArray(this.settings.uploadHistory) ? this.settings.uploadHistory : [];
		const idx = history.findIndex((item) => item && item.filePath === path);
		if (idx >= 0) {
			history[idx] = { ...history[idx], localDeletedAt: Date.now() };
			this.settings.uploadHistory = history;
			changed = true;
		}
		changed = this.syncState.markLocalMissing(path) || changed;
		if (changed) {
			await this.saveSettings();
			this.log(`Sync mapping marked local missing for deleted file: ${path}`);
		}
	}

	private async restoreLocalMappingPath(filePath: string, title?: string): Promise<void> {
		const path = String(filePath || '').trim();
		if (!path) {
			return;
		}
		let changed = false;
		const history = Array.isArray(this.settings.uploadHistory) ? this.settings.uploadHistory : [];
		const idx = history.findIndex((item) => item && item.filePath === path);
		if (idx >= 0 && history[idx].localDeletedAt) {
			const restored = { ...history[idx], title: title || history[idx].title };
			delete (restored as any).localDeletedAt;
			history[idx] = restored;
			this.settings.uploadHistory = history;
			changed = true;
		}
		changed = this.syncState.markLocalPresent(path, title) || changed;
		if (changed) {
			await this.saveSettings();
			this.log(`Sync mapping restored for local file: ${path}`);
		}
	}

	async removeMappingByDocToken(docToken: string): Promise<void> {
		const token = String(docToken || '').trim();
		if (!token) {
			return;
		}
		let changed = false;
		const history = Array.isArray(this.settings.uploadHistory) ? this.settings.uploadHistory : [];
		const nextHistory = history.filter((item) => !(item && item.docToken && String(item.docToken) === token));
		if (nextHistory.length !== history.length) {
			this.settings.uploadHistory = nextHistory;
			changed = true;
		}
		changed = this.syncState.removeByDocToken(token) || changed;
		if (changed) {
			await this.saveSettings();
		}
	}

	async removeMappingByFilePath(filePath: string): Promise<void> {
		const path = String(filePath || '').trim();
		if (!path) {
			return;
		}
		let changed = false;
		const history = Array.isArray(this.settings.uploadHistory) ? this.settings.uploadHistory : [];
		const nextHistory = history.filter((item) => !(item && item.filePath === path));
		if (nextHistory.length !== history.length) {
			this.settings.uploadHistory = nextHistory;
			changed = true;
		}
		changed = this.syncState.removeByFilePath(path) || changed;
		if (changed) {
			await this.saveSettings();
		}
	}

	/**
	 * 注册插件命令
	 */
	private registerCommands(): void {
		this.addCommand({
			id: 'share-current-note',
			name: '分享当前笔记到飞书',
			editorCallback: (editor: Editor, view: MarkdownView) => {
				this.shareCurrentNote();
			}
		});

		this.addCommand({
			id: 'smart-sync-current-note',
			name: '智能双向同步当前笔记',
			callback: async () => {
				await this.smartSyncCurrentNote();
			}
		});

		this.addCommand({
			id: 'sync-current-note',
			name: '上传/更新当前笔记到飞书',
			callback: async () => {
				await this.syncCurrentNote();
			}
		});

		this.addCommand({
			id: 'batch-sync-notes',
			name: '批量上传/更新笔记到飞书',
			callback: async () => {
				await this.batchSyncNotes();
			}
		});

		this.addCommand({
			id: 'batch-smart-sync-notes',
			name: '批量智能双向同步笔记',
			callback: async () => {
				await this.batchSmartSyncNotes();
			}
		});

		this.addCommand({
			id: 'run-scheduled-smart-sync-now',
			name: '立即执行定时智能同步范围',
			callback: async () => {
				await this.runScheduledSmartSync('manual', true);
			}
		});

		this.addCommand({
			id: 'overwrite-current-note-to-feishu',
			name: '覆盖到已有飞书文档',
			callback: async () => {
				const activeFile = this.app.workspace.getActiveFile();
				if (!activeFile || activeFile.extension !== 'md') {
					new Notice('❌ 没有打开的 Markdown 笔记');
					return;
				}
				await this.overwriteToFeishu(activeFile);
			}
		});

		this.addCommand({
			id: 'pull-current-note-from-bitable',
			name: '从多维表格更新当前笔记',
			callback: async () => {
				const activeFile = this.app.workspace.getActiveFile();
				if (!activeFile || activeFile.extension !== 'md') {
					new Notice('❌ 没有打开的 Markdown 笔记');
					return;
				}
				await this.pullFileFromBitable(activeFile);
			}
		});



		// 添加调试控制命令
		this.addCommand({
			id: 'toggle-feishu-debug',
			name: '🔧 切换飞书调试日志',
			callback: () => {
				if (Debug.isEnabled()) {
					Debug.disable();
					new Notice('🔇 飞书调试日志已关闭');
				} else {
					Debug.enable();
					new Notice('🔧 飞书调试日志已开启');
				}
			}
		});

		// 添加详细日志控制命令
		// （已移除）详细日志控制命令

		// 添加API测试命令
		this.addCommand({
			id: 'test-feishu-api',
			name: '🧪 测试飞书API连接',
			callback: async () => {
				this.log('🧪 Starting API test...');
				try {
					const testResult = await this.feishuApi.testApiConnection();
					this.log(`🧪 API test result: ${JSON.stringify(testResult)}`);
					new Notice(`API测试结果: ${testResult.success ? '成功' : '失败 - ' + testResult.error}`);
				} catch (error) {
					this.log(`🧪 API test error: ${(error as Error).message}`, 'error');
					new Notice(`API测试错误: ${(error as Error).message}`);
				}
			}
		});

		// （已移除）日志状态查看命令
	}

	private getBatchSyncFiles(): TFile[] {
		return this.getFilesForScope(
			this.settings.batchSyncScope || 'current_file',
			this.settings.batchSyncCustomFolder || ''
		);
	}

	private getScheduledSyncFiles(): TFile[] {
		return this.getFilesForScope(
			this.settings.scheduledSyncScope || 'tracked_files',
			this.settings.scheduledSyncCustomFolder || ''
		);
	}

	private getTrackedSyncFiles(): TFile[] {
		const states = Array.isArray(this.settings.syncStates) ? this.settings.syncStates : [];
		const seen = new Set<string>();
		const files: TFile[] = [];
		for (const state of states) {
			const path = String(state?.filePath || '').trim();
			if (!path || seen.has(path)) {
				continue;
			}
			const file = this.getMarkdownFileByPath(path);
			if (!file) {
				continue;
			}
			seen.add(path);
			files.push(file);
		}
		return files;
	}

	private getFilesForScope(scope: ScheduledSyncScope, customFolder: string): TFile[] {
		const all = this.app.vault.getMarkdownFiles();
		if (scope === 'tracked_files') {
			return this.getTrackedSyncFiles();
		}
		if (scope === 'vault_all') {
			return all;
		}
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile || activeFile.extension !== 'md') {
			return [];
		}
		if (scope === 'current_file') {
			return [activeFile];
		}
		if (scope === 'current_folder') {
			const folder = activeFile.parent?.path || '';
			return all.filter((f: TFile) => f.parent?.path === folder);
		}
		if (scope === 'custom_folder') {
			const folder = String(customFolder || '').trim();
			if (!folder) {
				return [];
			}
			return all.filter((f: TFile) => f.path.startsWith(folder.endsWith('/') ? folder : folder + '/'));
		}
		return [activeFile];
	}

	private normalizeScheduledSyncIntervalMinutes(value: number | string | undefined): number {
		const parsed = typeof value === 'number' ? value : Number(value);
		if (!Number.isFinite(parsed)) {
			return 30;
		}
		return Math.max(5, Math.min(24 * 60, Math.round(parsed)));
	}

	private getScheduledSyncReport(): ScheduledSyncReport {
		const existing = this.settings.scheduledSyncReport || {};
		return {
			status: 'idle',
			failureStreak: 0,
			...existing
		};
	}

	private async persistScheduledSyncReport(update: Partial<ScheduledSyncReport>): Promise<void> {
		this.settings.scheduledSyncReport = {
			...this.getScheduledSyncReport(),
			...update
		};
		await this.saveData(this.settings);
	}

	private getScheduledSyncPauseMessage(report?: ScheduledSyncReport): string {
		const activeReport = report || this.getScheduledSyncReport();
		if (!activeReport.pauseUntil || activeReport.pauseUntil <= Date.now()) {
			return '';
		}
		const remainingMinutes = Math.max(1, Math.ceil((activeReport.pauseUntil - Date.now()) / 60000));
		return `定时同步已暂停，约 ${remainingMinutes} 分钟后自动恢复`;
	}

	private clearScheduledSyncTimers(): void {
		if (this.scheduledSyncIntervalId !== null) {
			window.clearInterval(this.scheduledSyncIntervalId);
			this.scheduledSyncIntervalId = null;
		}
		if (this.scheduledSyncStartupTimeoutId !== null) {
			window.clearTimeout(this.scheduledSyncStartupTimeoutId);
			this.scheduledSyncStartupTimeoutId = null;
		}
		for (const intervalId of this.scheduledProfileIntervalIds.values()) {
			window.clearInterval(intervalId);
		}
		this.scheduledProfileIntervalIds.clear();
		for (const timeoutId of this.scheduledProfileStartupTimeoutIds.values()) {
			window.clearTimeout(timeoutId);
		}
		this.scheduledProfileStartupTimeoutIds.clear();
	}

	private configureScheduledSync(skipStartup: boolean = false): void {
		this.clearScheduledSyncTimers();
		if (this.settings.enableScheduledSync) {
			const intervalMinutes = this.normalizeScheduledSyncIntervalMinutes(this.settings.scheduledSyncIntervalMinutes);
			const intervalMs = intervalMinutes * 60 * 1000;
			this.scheduledSyncIntervalId = window.setInterval(() => {
				void this.runScheduledSmartSync('interval');
			}, intervalMs);

			if (!skipStartup && this.settings.scheduledSyncRunOnStartup) {
				this.scheduledSyncStartupTimeoutId = window.setTimeout(() => {
					void this.runScheduledSmartSync('startup');
				}, 15000);
			}
		}
		for (const profile of this.getScheduledBitableProfiles()) {
			const intervalMinutes = this.normalizeScheduledSyncIntervalMinutes(profile.scheduledSyncIntervalMinutes);
			const intervalMs = intervalMinutes * 60 * 1000;
			this.scheduledProfileIntervalIds.set(profile.id, window.setInterval(() => {
				void this.runScheduledBitableProfileSync(profile.id, 'interval');
			}, intervalMs));
			if (!skipStartup && profile.scheduledSyncRunOnStartup) {
				this.scheduledProfileStartupTimeoutIds.set(profile.id, window.setTimeout(() => {
					void this.runScheduledBitableProfileSync(profile.id, 'startup');
				}, 15000));
			}
		}
	}

	async runScheduledSmartSync(trigger: 'startup' | 'interval' | 'manual' = 'manual', showSummaryNotice: boolean = false): Promise<void> {
		const previousReport = this.getScheduledSyncReport();
		if (this.scheduledSyncInProgress) {
			if (showSummaryNotice) {
				new Notice('⏳ 定时同步正在执行中，请稍后再试');
			}
			return;
		}
		if (trigger !== 'manual' && previousReport.pauseUntil && previousReport.pauseUntil > Date.now()) {
			const message = this.getScheduledSyncPauseMessage(previousReport);
			this.log(`Scheduled sync paused: ${message}`, 'warn');
			await this.persistScheduledSyncReport({
				status: 'paused',
				lastTrigger: trigger,
				message
			});
			if (showSummaryNotice) {
				new Notice(message || '定时同步已暂停');
			}
			return;
		}
		if (!this.settings.accessToken || !this.settings.userInfo) {
			this.log('Scheduled sync skipped: authorization missing', 'warn');
			await this.persistScheduledSyncReport({
				lastRunAt: Date.now(),
				lastTrigger: trigger,
				status: 'skipped',
				totalFiles: 0,
				successCount: 0,
				failedCount: 0,
				skippedCount: 1,
				message: '缺少飞书授权，已跳过本次定时同步',
				lastError: 'authorization-missing'
			});
			if (showSummaryNotice) {
				new Notice('❌ 请先在设置中完成飞书授权');
			}
			return;
		}

		const files = this.getScheduledSyncFiles();
		if (!files.length) {
			await this.persistScheduledSyncReport({
				lastRunAt: Date.now(),
				lastTrigger: trigger,
				status: 'skipped',
				totalFiles: 0,
				successCount: 0,
				failedCount: 0,
				skippedCount: 1,
				message: '当前定时同步范围内没有可同步文件',
				lastError: undefined
			});
			if (showSummaryNotice) {
				new Notice('当前定时同步范围内没有可同步文件');
			}
			return;
		}

		const startedAt = Date.now();
		this.scheduledSyncInProgress = true;
		let successCount = 0;
		let failedCount = 0;
		let lastError = '';
		const initialTotal = files.length;
		await this.persistScheduledSyncReport({
			lastRunAt: startedAt,
			lastTrigger: trigger,
			status: 'running',
			totalFiles: initialTotal,
			successCount: 0,
			failedCount: 0,
			skippedCount: 0,
			message: `正在执行 ${files.length} 个文件的定时同步`,
			lastError: undefined,
			pauseUntil: trigger === 'manual' ? undefined : previousReport.pauseUntil
		});
		try {
			for (const file of files) {
				const ok = await this.smartSyncFile(file, {
					interactive: false,
					silent: true,
					source: 'scheduled'
				});
				if (ok) {
					successCount++;
				} else {
					failedCount++;
				}
			}
		} catch (error) {
			failedCount++;
			lastError = (error as Error)?.message || String(error);
			this.log(`Scheduled sync aborted: ${lastError}`, 'warn');
		} finally {
			this.scheduledSyncInProgress = false;
		}

		const durationMs = Date.now() - startedAt;
		const nextFailureStreak = failedCount > 0 && successCount === 0
			? (previousReport.failureStreak || 0) + 1
			: 0;
		const pauseUntil = trigger !== 'manual' && nextFailureStreak >= 3
			? Date.now() + 60 * 60 * 1000
			: undefined;
		const status: ScheduledSyncReport['status'] = failedCount === 0
			? 'success'
			: (successCount > 0 ? 'partial' : 'failed');
		const finalTotal = files.length;
		const message = status === 'success'
			? `定时同步完成：成功 ${successCount}/${finalTotal}`
			: status === 'partial'
				? `定时同步部分完成：成功 ${successCount}，失败 ${failedCount}`
				: (pauseUntil
					? `定时同步连续失败 ${nextFailureStreak} 次，已暂停 60 分钟`
					: `定时同步失败：${failedCount}/${finalTotal}`);
		await this.persistScheduledSyncReport({
			lastRunAt: startedAt,
			lastDurationMs: durationMs,
			lastTrigger: trigger,
			status: pauseUntil ? 'paused' : status,
			totalFiles: finalTotal,
			successCount,
			failedCount,
			skippedCount: 0,
			message,
			lastError: lastError || (failedCount > 0 ? 'one-or-more-files-failed' : undefined),
			failureStreak: nextFailureStreak,
			pauseUntil
		});
		this.log(`Scheduled sync (${trigger}) finished: success ${successCount}/${finalTotal}, failed ${failedCount}`);
		if (showSummaryNotice) {
			new Notice(message);
		}
	}

	async runScheduledBitableProfileSync(
		profileId: string,
		trigger: 'startup' | 'interval' | 'manual' = 'manual',
		showSummaryNotice: boolean = false
	): Promise<boolean> {
		const profile = this.getBitableProfileById(profileId);
		if (!profile || profile.enabled === false) {
			if (showSummaryNotice) {
				new Notice('未找到可同步的任务 Profile');
			}
			return false;
		}
		if (this.scheduledProfileInProgress.has(profile.id)) {
			if (showSummaryNotice) {
				new Notice(`${profile.name} 正在同步中，请稍后再试`);
			}
			return false;
		}
		if (!this.settings.accessToken || !this.settings.userInfo) {
			if (showSummaryNotice) {
				new Notice('请先在设置中完成飞书授权');
			}
			return false;
		}

		this.scheduledProfileInProgress.add(profile.id);
		try {
			const result = await this.syncBitableProfileFromRemote(profile, {
				interactive: false,
				silent: true,
				source: 'scheduled'
			});
			const message = result.failedCount === 0
				? `${profile.name} 同步完成：成功 ${result.successCount}/${result.total}`
				: (result.successCount > 0
					? `${profile.name} 部分完成：成功 ${result.successCount}，失败 ${result.failedCount}`
					: `${profile.name} 同步失败：${result.failedCount}/${result.total}`);
			this.log(`Scheduled profile sync (${trigger}) finished for ${profile.id}: success ${result.successCount}/${result.total}, failed ${result.failedCount}`);
			if (showSummaryNotice) {
				new Notice(message);
			}
			return result.failedCount === 0;
		} catch (error) {
			this.log(`Scheduled profile sync (${trigger}) failed for ${profile.id}: ${this.getErrorMessage(error)}`, 'warn');
			if (showSummaryNotice) {
				new Notice(`${profile.name} 同步失败：${this.getErrorMessage(error)}`);
			}
			return false;
		} finally {
			this.scheduledProfileInProgress.delete(profile.id);
		}
	}

	async smartSyncCurrentNote(): Promise<void> {
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile || activeFile.extension !== 'md') {
			new Notice('❌ 没有打开的 Markdown 笔记');
			return;
		}
		await this.smartSyncFile(activeFile);
	}

	async smartSyncFileByPath(filePath: string): Promise<boolean> {
		const file = this.getMarkdownFileByPath(filePath);
		if (!file) {
			new Notice('❌ 未找到对应的 Markdown 文件');
			return false;
		}
		return await this.smartSyncFile(file);
	}

	async pullFromFeishuByPath(filePath: string): Promise<boolean> {
		const file = this.getMarkdownFileByPath(filePath);
		if (!file) {
			new Notice('❌ 未找到对应的 Markdown 文件');
			return false;
		}
		return await this.updateFromFeishu(file);
	}

	async pushToFeishuByPath(filePath: string): Promise<void> {
		const file = this.getMarkdownFileByPath(filePath);
		if (!file) {
			new Notice('❌ 未找到对应的 Markdown 文件');
			return;
		}
		const rawContent = await this.app.vault.read(file);
		const feishuUrl = this.getFeishuUrlForFile(file, rawContent);
		if (feishuUrl) {
			await this.shareFile(file, { forceUpdateUrl: feishuUrl, syncTargetOverride: 'docx' });
		} else {
			await this.shareFile(file, { syncTargetOverride: 'docx' });
		}
	}

	async pullFromBitableByPath(filePath: string): Promise<boolean> {
		const file = this.getMarkdownFileByPath(filePath);
		if (!file) {
			new Notice('❌ 未找到对应的 Markdown 文件');
			return false;
		}
		return await this.pullFileFromBitable(file);
	}

	private getMarkdownFileByPath(filePath: string): TFile | null {
		const path = String(filePath || '').trim();
		if (!path) {
			return null;
		}
		const direct = this.app.vault.getFileByPath ? this.app.vault.getFileByPath(path) : null;
		if (direct && direct.extension === 'md') {
			return direct;
		}
		return this.app.vault.getMarkdownFiles().find((file: TFile) => file.path === path) || null;
	}

	private shouldAutoPullRemoteVersion(file: TFile, remoteUpdatedAt?: number): boolean {
		return isRemoteUpdatedAfterLocal(remoteUpdatedAt, file?.stat?.mtime);
	}

	private getBitableProfiles(): BitableSyncProfile[] {
		this.settings.bitableProfiles = mergeDefaultBitableProfiles(this.settings.bitableProfiles);
		return this.settings.bitableProfiles;
	}

	private getBitableProfileById(profileId: string): BitableSyncProfile | null {
		const id = String(profileId || '').trim();
		if (!id) {
			return null;
		}
		return this.getBitableProfiles().find((profile) => profile.id === id) || null;
	}

	private getBitableProfileForFile(file: TFile, content: string): BitableSyncProfile | null {
		return selectBitableProfileForFile(this.getBitableProfiles(), file.path, content);
	}

	private getScheduledBitableProfiles(): BitableSyncProfile[] {
		return selectScheduledBitableProfiles(this.getBitableProfiles(), this.settings.scheduledBitableProfileIds || []);
	}

	private getProfileRecordIdForFile(file: TFile, content: string, profile: BitableSyncProfile): string {
		const direct = getProfileRecordIdFromMarkdown(content);
		if (direct) {
			return direct;
		}
		const history = Array.isArray(this.settings.uploadHistory) ? this.settings.uploadHistory : [];
		const existing = history.find((item) => item && item.filePath === file.path && this.historyItemMatchesProfile(item, profile));
		const state = this.syncState.getState(file.path);
		if (existing?.bitableRecordId) {
			return String(existing.bitableRecordId);
		}
		if (state?.bitableRecordId && this.syncStateItemMatchesProfile(state, profile)) {
			return String(state.bitableRecordId);
		}
		return '';
	}

	private historyItemMatchesProfile(item: any, profile: BitableSyncProfile): boolean {
		if (!item) {
			return false;
		}
		if (item.bitableProfileId) {
			return String(item.bitableProfileId) === profile.id;
		}
		if (item.bitableTableId) {
			return String(item.bitableTableId) === profile.tableId;
		}
		return true;
	}

	private syncStateItemMatchesProfile(item: any, profile: BitableSyncProfile): boolean {
		if (!item) {
			return false;
		}
		if (item.bitableProfileId) {
			return String(item.bitableProfileId) === profile.id;
		}
		if (item.bitableTableId) {
			return String(item.bitableTableId) === profile.tableId;
		}
		return true;
	}

	private isBitableRecordMissingError(error: unknown): boolean {
		const message = this.getErrorMessage(error);
		return /404/.test(message)
			|| /not\s*found/i.test(message)
			|| /record.*(deleted|not\s*found|not\s*exist)/i.test(message)
			|| /记录.*(不存在|已删除)/.test(message)
			|| /已删除.*记录/.test(message);
	}

	private buildProfileRemoteDeletedMessage(profile: BitableSyncProfile, recordId?: string): string {
		const suffix = recordId ? `（recordId: ${recordId}）` : '';
		return `${profile.name} 远端记录已删除${suffix}，本地文件暂时保留`;
	}

	private async markProfileRemoteMissing(file: TFile, profile: BitableSyncProfile, recordId?: string, title?: string): Promise<void> {
		this.syncState.upsert({
			filePath: file.path,
			title: title || file.basename,
			bitableRecordId: recordId,
			bitableProfileId: profile.id,
			bitableAppToken: profile.appToken,
			bitableTableId: profile.tableId,
			bitableViewId: profile.viewId,
			direction: 'bitable',
			status: 'error',
			error: this.buildProfileRemoteDeletedMessage(profile, recordId)
		});
		await this.saveSettings();
	}

	private async markProfileRemoteMissingFromListing(profile: BitableSyncProfile, remoteRecordIds: Set<string>): Promise<void> {
		const candidates = new Map<string, { filePath: string; title?: string; recordId: string }>();
		const history = Array.isArray(this.settings.uploadHistory) ? this.settings.uploadHistory : [];
		const states = Array.isArray(this.settings.syncStates) ? this.settings.syncStates : [];
		const collect = (item: any, title?: string) => {
			if (!item || !this.historyItemMatchesProfile(item, profile) && !this.syncStateItemMatchesProfile(item, profile)) {
				return;
			}
			const filePath = String(item.filePath || '').trim();
			const recordId = String(item.bitableRecordId || '').trim();
			if (!filePath || !recordId || remoteRecordIds.has(recordId)) {
				return;
			}
			const file = this.app.vault.getAbstractFileByPath(filePath);
			if (!(file instanceof TFile) || file.extension !== 'md') {
				return;
			}
			if (!candidates.has(filePath)) {
				candidates.set(filePath, { filePath, title, recordId });
			}
		};
		history.forEach((item) => collect(item, item?.title));
		states.forEach((item) => collect(item, item?.title));
		let changed = false;
		for (const candidate of candidates.values()) {
			const existing = this.syncState.getState(candidate.filePath);
			const nextError = this.buildProfileRemoteDeletedMessage(profile, candidate.recordId);
			if (existing?.status === 'error' && existing.lastError === nextError) {
				continue;
			}
			this.syncState.upsert({
				filePath: candidate.filePath,
				title: candidate.title,
				bitableRecordId: candidate.recordId,
				bitableProfileId: profile.id,
				bitableAppToken: profile.appToken,
				bitableTableId: profile.tableId,
				bitableViewId: profile.viewId,
				direction: 'bitable',
				status: 'error',
				error: nextError
			});
			changed = true;
		}
		if (changed) {
			await this.saveSettings();
		}
	}

	private hashBitableProfileRemote(profile: BitableSyncProfile, recordId: string, fields: Record<string, any>): string {
		return this.syncState.hashContent(buildProfileRemoteManagedContent(profile, recordId, fields));
	}

	private async getBitableProfileFieldMeta(profile: BitableSyncProfile): Promise<Map<string, any>> {
		const fieldsMeta = await this.feishuApi.getBitableTableFields(profile.appToken, profile.tableId);
		if (!fieldsMeta.success || !fieldsMeta.fields) {
			throw new Error(fieldsMeta.error || `读取 Profile ${profile.name} 字段失败`);
		}
		return new Map(fieldsMeta.fields.map((field) => [field.name, field] as const));
	}

	private setProfileLogicalField(
		fields: Record<string, any>,
		profile: BitableSyncProfile,
		fieldMetaByName: Map<string, any>,
		logicalKey: string,
		value: any,
		now: number
	): void {
		if (value === undefined || value === null || value === '') {
			return;
		}
		const fieldName = resolveProfileFieldName(profile, logicalKey, new Set(fieldMetaByName.keys()));
		if (!fieldName) {
			return;
		}
		fields[fieldName] = normalizeBitableWriteValue(value, fieldMetaByName.get(fieldName), now);
	}

	private async ensureProfileTargetFolder(folderPath: string): Promise<void> {
		const normalized = normalizePath(String(folderPath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''));
		if (!normalized) {
			return;
		}
		const parts = normalized.split('/').filter((part) => !!part);
		let current = '';
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			const exists = await this.app.vault.adapter.exists(current);
			if (!exists) {
				await this.app.vault.createFolder(current);
			}
		}
	}

	private async buildProfileFilePath(profile: BitableSyncProfile, recordId: string, fields: Record<string, any>): Promise<string> {
		const targetDir = normalizePath(String(profile.targetDir || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''));
		const baseName = renderProfileFileName(profile, recordId, fields);
		const first = normalizePath(`${targetDir}/${baseName}.md`);
		const existing = this.getMarkdownFileByPath(first);
		if (!existing) {
			return first;
		}
		const current = await this.app.vault.read(existing);
		if (getProfileRecordIdFromMarkdown(current) === recordId) {
			return first;
		}
		return normalizePath(`${targetDir}/${baseName}-${recordId}.md`);
	}

	private async ensureProfileFilePath(file: TFile, profile: BitableSyncProfile, recordId: string, fields: Record<string, any>): Promise<TFile> {
		await this.ensureProfileTargetFolder(profile.targetDir);
		const targetPath = await this.buildProfileFilePath(profile, recordId, fields);
		if (!targetPath || targetPath === file.path) {
			return file;
		}
		if (this.app.fileManager && typeof this.app.fileManager.renameFile === 'function') {
			await this.app.fileManager.renameFile(file, targetPath);
		} else {
			await this.app.vault.rename(file, targetPath);
		}
		return this.getMarkdownFileByPath(targetPath) || file;
	}

	private async findProfileFileByRecordId(profile: BitableSyncProfile, recordId: string): Promise<TFile | null> {
		const rid = String(recordId || '').trim();
		if (!rid) {
			return null;
		}
		const states = Array.isArray(this.settings.syncStates) ? this.settings.syncStates : [];
		const state = states.find((item) => item
			&& item.bitableRecordId === rid
			&& this.syncStateItemMatchesProfile(item, profile)
			&& item.filePath);
		if (state?.filePath) {
			const file = this.getMarkdownFileByPath(state.filePath);
			if (file) {
				return file;
			}
		}
		const files = this.app.vault.getMarkdownFiles().filter((file: TFile) => {
			const targetDir = normalizePath(String(profile.targetDir || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''));
			return targetDir ? (file.path === targetDir || file.path.startsWith(`${targetDir}/`)) : true;
		});
		for (const file of files) {
			try {
				const content = await this.app.vault.read(file);
				if (getProfileRecordIdFromMarkdown(content) === rid) {
					return file;
				}
			} catch {
			}
		}
		return null;
	}

	private async upsertProfileHistoryAndState(params: {
		file: TFile;
		profile: BitableSyncProfile;
		recordId: string;
		title: string;
		content: string;
		remoteHash?: string;
		remoteUpdatedAt?: number;
		status?: 'synced' | 'conflict' | 'error';
		error?: string;
	}): Promise<void> {
		const now = Date.now();
		const history = Array.isArray(this.settings.uploadHistory) ? this.settings.uploadHistory : [];
		const idx = history.findIndex((item) => item && item.filePath === params.file.path);
		const item = {
			filePath: params.file.path,
			title: params.title,
			bitableRecordId: params.recordId,
			bitableProfileId: params.profile.id,
			bitableAppToken: params.profile.appToken,
			bitableTableId: params.profile.tableId,
			bitableViewId: params.profile.viewId,
			updatedAt: now
		};
		if (idx >= 0) {
			history[idx] = { ...history[idx], ...item };
		} else {
			history.unshift(item);
		}
		this.settings.uploadHistory = history;
		this.syncState.upsert({
			filePath: params.file.path,
			title: params.title,
			content: params.content,
			bitableRecordId: params.recordId,
			bitableProfileId: params.profile.id,
			bitableAppToken: params.profile.appToken,
			bitableTableId: params.profile.tableId,
			bitableViewId: params.profile.viewId,
			direction: 'bitable',
			status: params.status,
			error: params.error,
			remoteHash: params.remoteHash,
			remoteUpdatedAt: params.remoteUpdatedAt,
			bitableRemoteHash: params.remoteHash,
			bitableRemoteUpdatedAt: params.remoteUpdatedAt
		});
		await this.saveSettings();
	}

	private getBitableRecordIdForFile(file: TFile, content: string): string {
		const history = Array.isArray(this.settings.uploadHistory) ? this.settings.uploadHistory : [];
		const existing = history.find((item) => item && item.filePath === file.path);
		const state = this.syncState.getState(file.path);
		const profileRecordId = getProfileRecordIdFromMarkdown(content);
		const frontMatterRecordId = this.extractFrontMatterValue(content, 'recordId');
		return existing && existing.bitableRecordId
			? String(existing.bitableRecordId)
			: (state && state.bitableRecordId ? String(state.bitableRecordId) : (profileRecordId || frontMatterRecordId));
	}

	private hashBitableFields(fields: Record<string, any> | undefined | null): string {
		return this.syncState.hashContent(this.stableStringify(fields || {}));
	}

	private stableStringify(value: any): string {
		if (value === null || value === undefined) {
			return 'null';
		}
		if (Array.isArray(value)) {
			return `[${value.map((item) => this.stableStringify(item)).join(',')}]`;
		}
		if (typeof value === 'object') {
			const keys = Object.keys(value).sort();
			return `{${keys.map((key) => `${JSON.stringify(key)}:${this.stableStringify(value[key])}`).join(',')}}`;
		}
		return JSON.stringify(value);
	}

	private async recordSyncError(file: TFile | null | undefined, direction: SyncDirection, error: unknown, context: string, extra?: SyncErrorExtra): Promise<void> {
		if (!file || file.extension !== 'md' || !this.syncState) {
			return;
		}
		try {
			const content = await this.app.vault.read(file);
			const history = Array.isArray(this.settings.uploadHistory) ? this.settings.uploadHistory : [];
			const existing = history.find((item) => item && item.filePath === file.path);
			const state = this.syncState.getState(file.path);
			this.syncState.upsert({
				filePath: file.path,
				title: file.basename,
				content,
				docToken: extra?.docToken || (existing && existing.docToken ? String(existing.docToken) : state?.docToken),
				url: extra?.url || (existing && existing.url ? String(existing.url) : state?.url),
				bitableRecordId: extra?.bitableRecordId || (existing && existing.bitableRecordId ? String(existing.bitableRecordId) : state?.bitableRecordId),
				direction,
				status: 'error',
				error: `${context}: ${this.getErrorMessage(error)}`,
				remoteHash: extra?.remoteHash,
				remoteRevision: extra?.remoteRevision,
				remoteUpdatedAt: extra?.remoteUpdatedAt,
				docRemoteRevision: extra?.docRemoteRevision,
				docRemoteUpdatedAt: extra?.docRemoteUpdatedAt,
				bitableRemoteHash: extra?.bitableRemoteHash,
				bitableRemoteUpdatedAt: extra?.bitableRemoteUpdatedAt
			});
			await this.saveSettings();
		} catch (stateError) {
			this.log(`Failed to record sync error for ${file.path}: ${this.getErrorMessage(stateError)}`, 'warn');
		}
	}

	private getErrorMessage(error: unknown): string {
		return (error as Error)?.message || String(error);
	}

	private getErrorDirectionForTarget(target?: SyncTarget): SyncDirection {
		return target === 'bitable' ? 'bitable' : 'obsidian-to-feishu';
	}

	private async smartSyncFile(file: TFile, options?: SyncExecutionOptions): Promise<boolean> {
		const interactive = options?.interactive !== false;
		const silent = options?.silent === true;
		const syncLabel = options?.source === 'scheduled' ? '定时同步' : '智能同步';
		if (!file || file.extension !== 'md') {
			if (!silent) {
				new Notice('❌ 只支持 Markdown 文件');
			}
			return false;
		}
		if (!this.settings.accessToken || !this.settings.userInfo) {
			if (!silent) {
				new Notice('❌ 请先在设置中完成飞书授权');
			}
			return false;
		}

		try {
			const rawContent = await this.app.vault.read(file);
			if (this.settings.syncTarget === 'bitable') {
				return await this.smartSyncBitableFile(file, rawContent, options);
			}
			if (this.settings.syncTarget === 'both') {
				return await this.smartSyncBothFile(file, rawContent, options);
			}
			const feishuUrl = this.getFeishuUrlForFile(file, rawContent);
			if (!feishuUrl) {
				if (!silent) {
					new Notice('未找到飞书映射，正在创建新文档');
				}
				return await this.shareFile(file, { silent });
			}

			const docToken = this.feishuApi.extractDocumentIdFromUrl(feishuUrl);
			const remoteMeta = docToken ? await this.feishuApi.getDocumentMeta(docToken) : null;
			const evaluation = this.syncState.evaluateSync(file.path, rawContent, {
				kind: 'doc',
				revision: remoteMeta?.revision,
				updatedAt: remoteMeta?.updatedAt
			});

			if (evaluation.hasLocalChanges && evaluation.hasRemoteChanges) {
				if (this.shouldAutoPullRemoteVersion(file, remoteMeta?.updatedAt)) {
					this.log(`${syncLabel} auto-preferred remote doc version for ${file.path}`);
					return await this.updateFromFeishu(file, { ...options, forceRemoteOverwrite: true });
				}
				if (!interactive) {
					this.syncState.upsert({
						filePath: file.path,
						title: file.basename,
						content: rawContent,
						docToken: this.extractDocTokenFromUrl(feishuUrl) || undefined,
						url: feishuUrl,
						direction: 'obsidian-to-feishu',
						status: 'conflict',
						error: `${syncLabel}检测到本地和飞书都有改动，已跳过`,
						remoteRevision: remoteMeta?.revision,
						remoteUpdatedAt: remoteMeta?.updatedAt
					});
					await this.saveSettings();
					this.log(`${syncLabel} skipped conflict for ${file.path}`, 'warn');
					return false;
				}
				const choice = await this.chooseSmartSyncConflictAction(file.basename);
				if (choice === 'cancel') {
					this.syncState.upsert({
						filePath: file.path,
						title: file.basename,
						content: rawContent,
						docToken: this.extractDocTokenFromUrl(feishuUrl) || undefined,
						url: feishuUrl,
						direction: 'obsidian-to-feishu',
						status: 'conflict',
						error: '智能同步检测到双向变更，用户取消',
						remoteRevision: remoteMeta?.revision,
						remoteUpdatedAt: remoteMeta?.updatedAt
					});
					await this.saveSettings();
					if (!silent) {
						new Notice('已取消：本地和飞书都有改动');
					}
					return false;
				}
				if (choice === 'pull') {
					return await this.updateFromFeishu(file, options);
				}
				return await this.shareFile(file, { forceUpdateUrl: feishuUrl, silent });
			}

			if (evaluation.hasRemoteChanges) {
				return await this.updateFromFeishu(file, options);
			}

			if (evaluation.hasLocalChanges || !evaluation.hasBaseline) {
				return await this.shareFile(file, { forceUpdateUrl: feishuUrl, silent });
			}

			if (!silent) {
				new Notice('✅ 本地和飞书已是最新');
			}
			return true;
		} catch (error) {
			await this.recordSyncError(file, this.getErrorDirectionForTarget(this.settings.syncTarget), error, syncLabel);
			if (!silent) {
				this.handleError(error as Error, syncLabel);
			} else {
				this.log(`${syncLabel} failed for ${file.path}: ${this.getErrorMessage(error)}`, 'warn');
			}
			return false;
		}
	}

	private async smartSyncBitableFile(file: TFile, rawContent: string, options?: SyncExecutionOptions): Promise<boolean> {
		const profile = this.getBitableProfileForFile(file, rawContent);
		if (profile) {
			return await this.smartSyncBitableProfileFile(file, rawContent, profile, options);
		}
		const interactive = options?.interactive !== false;
		const silent = options?.silent === true;
		const syncLabel = options?.source === 'scheduled' ? '定时同步' : '智能同步';
		if (!this.settings.bitableAppToken || !this.settings.bitableTableId) {
			if (!silent) {
				new Notice('❌ 请先在设置中填写 Bitable App Token 和 Bitable Table ID');
			}
			return false;
		}
		const recordId = this.getBitableRecordIdForFile(file, rawContent);
		if (!recordId) {
			if (!silent) {
				new Notice('未找到 Bitable 映射，正在创建/更新多维表格记录');
			}
			return await this.shareFile(file, { silent });
		}
		const record = await this.feishuApi.getBitableRecord(this.settings.bitableAppToken, this.settings.bitableTableId, recordId);
		if (!record.success) {
			throw new Error(record.error || '读取 Bitable 记录失败');
		}
		const remoteHash = this.hashBitableFields(record.fields);
		const evaluation = this.syncState.evaluateSync(file.path, rawContent, {
			kind: 'bitable',
			hash: remoteHash,
			updatedAt: record.updatedAt
		});
		if (evaluation.hasLocalChanges && evaluation.hasRemoteChanges) {
			if (this.shouldAutoPullRemoteVersion(file, record.updatedAt)) {
				this.log(`${syncLabel} auto-preferred remote bitable version for ${file.path}`);
				return await this.pullFileFromBitable(file, { ...options, forceRemoteOverwrite: true });
			}
			if (!interactive) {
				this.syncState.upsert({
					filePath: file.path,
					title: file.basename,
					content: rawContent,
					bitableRecordId: record.recordId || recordId,
					direction: 'bitable',
					status: 'conflict',
					error: `${syncLabel}检测到本地和多维表格都有改动，已跳过`,
					remoteHash,
					remoteUpdatedAt: record.updatedAt
				});
				await this.saveSettings();
				this.log(`${syncLabel} skipped Bitable conflict for ${file.path}`, 'warn');
				return false;
			}
			const choice = await this.chooseSmartSyncConflictAction(file.basename);
			if (choice === 'cancel') {
				this.syncState.upsert({
					filePath: file.path,
					title: file.basename,
					content: rawContent,
					bitableRecordId: record.recordId || recordId,
					direction: 'bitable',
					status: 'conflict',
					error: '智能同步检测到 Bitable 双向变更，用户取消',
					remoteHash,
					remoteUpdatedAt: record.updatedAt
				});
				await this.saveSettings();
				if (!silent) {
					new Notice('已取消：本地和多维表格都有改动');
				}
				return false;
			}
			if (choice === 'pull') {
				return await this.pullFileFromBitable(file, options);
			}
			return await this.shareFile(file, { silent });
		}
		if (evaluation.hasRemoteChanges) {
			return await this.pullFileFromBitable(file, options);
		}
		if (evaluation.hasLocalChanges || !evaluation.hasBaseline) {
			return await this.shareFile(file, { silent });
		}
		if (!silent) {
			new Notice('✅ 本地和多维表格已是最新');
		}
		return true;
	}

	private async smartSyncBitableProfileFile(file: TFile, rawContent: string, profile: BitableSyncProfile, options?: SyncExecutionOptions): Promise<boolean> {
		const interactive = options?.interactive !== false;
		const silent = options?.silent === true;
		const syncLabel = options?.source === 'scheduled' ? '定时同步' : '智能同步';
		const recordId = this.getProfileRecordIdForFile(file, rawContent, profile);
		if (!recordId) {
			if (!silent) {
				new Notice(`未找到 ${profile.name} 记录映射，正在创建多维表格记录`);
			}
			return !!(await this.syncFileToBitableProfile(file, file.basename, rawContent, profile, undefined, silent));
		}
		const record = await this.feishuApi.getBitableRecord(profile.appToken, profile.tableId, recordId);
		if (!record.success || !record.fields) {
			if (this.isBitableRecordMissingError(record.error)) {
				await this.markProfileRemoteMissing(file, profile, recordId);
				if (!silent) {
					new Notice(`⚠️ ${profile.name} 远端记录已删除，本地文件已保留`);
				}
				return false;
			}
			throw new Error(record.error || `读取 ${profile.name} 记录失败`);
		}
		const finalRecordId = record.recordId || recordId;
		const remoteHash = this.hashBitableProfileRemote(profile, finalRecordId, record.fields);
		const managedContent = buildProfileManagedContent(rawContent, profile);
		const evaluation = this.syncState.evaluateSync(file.path, managedContent, {
			kind: 'bitable',
			hash: remoteHash,
			updatedAt: record.updatedAt
		});
		if (evaluation.hasLocalChanges && evaluation.hasRemoteChanges) {
			if (this.shouldAutoPullRemoteVersion(file, record.updatedAt)) {
				this.log(`${syncLabel} auto-preferred remote ${profile.name} version for ${file.path}`);
				return await this.pullFileFromBitableProfile(file, profile, { ...options, forceRemoteOverwrite: true });
			}
			if (!interactive) {
				await this.upsertProfileHistoryAndState({
					file,
					profile,
					recordId: finalRecordId,
					title: file.basename,
					content: managedContent,
					remoteHash,
					remoteUpdatedAt: record.updatedAt,
					status: 'conflict',
					error: `${syncLabel}检测到 ${profile.name} 本地和远端都有改动，已跳过`
				});
				this.log(`${syncLabel} skipped ${profile.name} conflict for ${file.path}`, 'warn');
				return false;
			}
			const choice = await this.chooseSmartSyncConflictAction(file.basename);
			if (choice === 'pull') {
				return await this.pullFileFromBitableProfile(file, profile, options);
			}
			if (choice === 'push') {
				return !!(await this.syncFileToBitableProfile(file, file.basename, rawContent, profile, undefined, silent));
			}
			await this.upsertProfileHistoryAndState({
				file,
				profile,
				recordId: finalRecordId,
				title: file.basename,
				content: managedContent,
				remoteHash,
				remoteUpdatedAt: record.updatedAt,
				status: 'conflict',
				error: `智能同步检测到 ${profile.name} 双向变更，用户取消`
			});
			if (!silent) {
				new Notice(`已取消：${profile.name} 本地和远端都有改动`);
			}
			return false;
		}
		if (evaluation.hasRemoteChanges) {
			return await this.pullFileFromBitableProfile(file, profile, options);
		}
		if (evaluation.hasLocalChanges || !evaluation.hasBaseline) {
			return !!(await this.syncFileToBitableProfile(file, file.basename, rawContent, profile, undefined, silent));
		}
		await this.ensureProfileFilePath(file, profile, finalRecordId, record.fields);
		if (!silent) {
			new Notice(`✅ ${profile.name} 本地和远端已是最新`);
		}
		return true;
	}

	private async syncFileToBitableProfile(file: TFile, title: string, rawContent: string, profile: BitableSyncProfile, statusNotice?: Notice, silent: boolean = false): Promise<string | undefined> {
		const now = Date.now();
		const fieldMetaByName = await this.getBitableProfileFieldMeta(profile);
		const fields = buildProfileBitableFieldsFromMarkdown(rawContent, profile, fieldMetaByName, now);
		this.setProfileLogicalField(fields, profile, fieldMetaByName, 'title', title || file.basename, now);
		const recordId = this.getProfileRecordIdForFile(file, rawContent, profile) || undefined;
		statusNotice?.setMessage(`📊 正在同步 ${profile.name}...`);
		const upsert = await this.feishuApi.upsertBitableRecord({
			appToken: profile.appToken,
			tableId: profile.tableId,
			recordId,
			fields
		});
		if (!upsert.success) {
			throw new Error(upsert.error || `同步 ${profile.name} 失败`);
		}
		const finalRecordId = upsert.recordId || recordId;
		if (!finalRecordId) {
			throw new Error(`同步 ${profile.name} 后未返回 recordId`);
		}
		const bitableMeta = await this.feishuApi.getBitableRecord(profile.appToken, profile.tableId, finalRecordId);
		if (!bitableMeta.success || !bitableMeta.fields) {
			throw new Error(bitableMeta.error || `读取 ${profile.name} 同步后记录失败`);
		}
		const nextContent = applyProfileRecordToMarkdown(rawContent, profile, finalRecordId, bitableMeta.fields, now, fieldMetaByName);
		if (nextContent !== rawContent) {
			await this.app.vault.modify(file, nextContent);
		}
		const targetFile = await this.ensureProfileFilePath(file, profile, finalRecordId, bitableMeta.fields);
		const remoteHash = this.hashBitableProfileRemote(profile, finalRecordId, bitableMeta.fields);
		await this.upsertProfileHistoryAndState({
			file: targetFile,
			profile,
			recordId: finalRecordId,
			title: targetFile.basename,
			content: buildProfileManagedContent(nextContent, profile),
			remoteHash,
			remoteUpdatedAt: bitableMeta.updatedAt
		});
		if (!silent && !this.settings.suppressShareNotices) {
			new Notice(`✅ 已同步到 ${profile.name}`);
		}
		return finalRecordId;
	}

	private async syncBitableProfileFromRemote(profile: BitableSyncProfile, options?: SyncExecutionOptions): Promise<{ total: number; successCount: number; failedCount: number }> {
		const result = await this.feishuApi.listBitableRecords({
			appToken: profile.appToken,
			tableId: profile.tableId,
			viewId: profile.viewId
		});
		if (!result.success || !result.records) {
			throw new Error(result.error || `读取 ${profile.name} 记录列表失败`);
		}
		let successCount = 0;
		let failedCount = 0;
		const fieldMetaByName = await this.getBitableProfileFieldMeta(profile);
		const remoteRecordIds = new Set(result.records.map((record) => String(record.recordId || '').trim()).filter((recordId) => !!recordId));
		for (const record of result.records) {
			try {
				const ok = await this.syncBitableProfileRecord(profile, record, fieldMetaByName, options);
				if (ok) {
					successCount++;
				} else {
					failedCount++;
				}
			} catch (error) {
				failedCount++;
				this.log(`Sync ${profile.name} record ${record.recordId} failed: ${this.getErrorMessage(error)}`, 'warn');
			}
		}
		await this.markProfileRemoteMissingFromListing(profile, remoteRecordIds);
		return { total: result.records.length, successCount, failedCount };
	}

	private async syncBitableProfileRecord(
		profile: BitableSyncProfile,
		record: { recordId: string; fields: Record<string, any>; updatedAt?: number },
		fieldMetaByName: Map<string, any>,
		options?: SyncExecutionOptions
	): Promise<boolean> {
		const silent = options?.silent === true;
		const interactive = options?.interactive !== false;
		const remoteHash = this.hashBitableProfileRemote(profile, record.recordId, record.fields);
		let file = await this.findProfileFileByRecordId(profile, record.recordId);
		if (!file) {
			await this.ensureProfileTargetFolder(profile.targetDir);
			const path = await this.buildProfileFilePath(profile, record.recordId, record.fields);
			const createdContent = buildProfileMarkdownFromRecord(profile, record.recordId, record.fields, Date.now(), fieldMetaByName);
			const createdFile = await this.app.vault.create(path, createdContent) as TFile;
			await this.upsertProfileHistoryAndState({
				file: createdFile,
				profile,
				recordId: record.recordId,
				title: createdFile.basename,
				content: buildProfileManagedContent(createdContent, profile),
				remoteHash,
				remoteUpdatedAt: record.updatedAt
			});
			return true;
		}

		const current = await this.app.vault.read(file);
		const managedContent = buildProfileManagedContent(current, profile);
		const evaluation = this.syncState.evaluateSync(file.path, managedContent, {
			kind: 'bitable',
			hash: remoteHash,
			updatedAt: record.updatedAt
		});
		if (evaluation.hasLocalChanges && evaluation.hasRemoteChanges) {
			if (this.shouldAutoPullRemoteVersion(file, record.updatedAt)) {
				this.log(`smart sync auto-preferred remote ${profile.name} version for ${file.path}`);
				return await this.pullFileFromBitableProfile(file, profile, { ...options, forceRemoteOverwrite: true });
			}
			await this.upsertProfileHistoryAndState({
				file,
				profile,
				recordId: record.recordId,
				title: file.basename,
				content: managedContent,
				remoteHash,
				remoteUpdatedAt: record.updatedAt,
				status: 'conflict',
				error: `Profile ${profile.name} 检测到本地受管内容和远端记录都有改动`
			});
			return false;
		}
		if (evaluation.hasLocalChanges && !evaluation.hasRemoteChanges) {
			return !!(await this.syncFileToBitableProfile(file, file.basename, current, profile, undefined, silent));
		}
		if (evaluation.hasRemoteChanges || !evaluation.hasBaseline) {
			if (!interactive) {
				const nextContent = applyProfileRecordToMarkdown(current, profile, record.recordId, record.fields, Date.now(), fieldMetaByName);
				if (nextContent !== current) {
					await this.app.vault.modify(file, nextContent);
				}
				const targetFile = await this.ensureProfileFilePath(file, profile, record.recordId, record.fields);
				await this.upsertProfileHistoryAndState({
					file: targetFile,
					profile,
					recordId: record.recordId,
					title: targetFile.basename,
					content: buildProfileManagedContent(nextContent, profile),
					remoteHash,
					remoteUpdatedAt: record.updatedAt
				});
				return true;
			}
			return await this.pullFileFromBitableProfile(file, profile, options);
		}
		await this.ensureProfileFilePath(file, profile, record.recordId, record.fields);
		return true;
	}

	private async syncBothTargetsFromLocal(file: TFile, options?: SyncExecutionOptions): Promise<boolean> {
		const latestContent = await this.app.vault.read(file);
		const feishuUrl = this.getFeishuUrlForFile(file, latestContent);
		return await this.shareFile(file, {
			...(feishuUrl ? { forceUpdateUrl: feishuUrl } : {}),
			syncTargetOverride: 'both',
			silent: options?.silent
		});
	}

	private async smartSyncBothFile(file: TFile, rawContent: string, options?: SyncExecutionOptions): Promise<boolean> {
		const interactive = options?.interactive !== false;
		const silent = options?.silent === true;
		const syncLabel = options?.source === 'scheduled' ? '定时同步' : '智能同步';
		const feishuUrl = this.getFeishuUrlForFile(file, rawContent);
		const docToken = feishuUrl ? this.feishuApi.extractDocumentIdFromUrl(feishuUrl) : '';
		const remoteMeta = docToken ? await this.feishuApi.getDocumentMeta(docToken) : null;
		const feishuEvaluation = this.syncState.evaluateSync(file.path, rawContent, {
			kind: 'doc',
			revision: remoteMeta?.revision,
			updatedAt: remoteMeta?.updatedAt
		});
		const profile = this.getBitableProfileForFile(file, rawContent);

		let bitableRemoteHash: string | undefined;
		let bitableUpdatedAt: number | undefined;
		const bitableContent = profile ? buildProfileManagedContent(rawContent, profile) : rawContent;
		const bitableRecordId = profile
			? this.getProfileRecordIdForFile(file, rawContent, profile)
			: this.getBitableRecordIdForFile(file, rawContent);
		const bitableAppToken = profile ? profile.appToken : this.settings.bitableAppToken;
		const bitableTableId = profile ? profile.tableId : this.settings.bitableTableId;
		const bitableViewId = profile ? profile.viewId : undefined;
		if (bitableRecordId && !profile && (!bitableAppToken || !bitableTableId)) {
			throw new Error('两者都同步需要填写 Bitable App Token 和 Bitable Table ID，才能检查多维表格远端改动');
		}
		if (bitableRecordId && bitableAppToken && bitableTableId) {
			const record = await this.feishuApi.getBitableRecord(bitableAppToken, bitableTableId, bitableRecordId);
			if (!record.success || !record.fields) {
				throw new Error(record.error || (profile ? `读取 ${profile.name} 记录失败` : '读取 Bitable 记录失败'));
			}
			const finalRecordId = record.recordId || bitableRecordId;
			bitableRemoteHash = profile
				? this.hashBitableProfileRemote(profile, finalRecordId, record.fields)
				: this.hashBitableFields(record.fields);
			bitableUpdatedAt = record.updatedAt;
		}
		const bitableEvaluation = this.syncState.evaluateSync(file.path, bitableContent, {
			kind: 'bitable',
			hash: bitableRemoteHash,
			updatedAt: bitableUpdatedAt
		});
		const pullBitableTarget = async (forceRemoteOverwrite = false): Promise<boolean> => {
			const nextOptions = forceRemoteOverwrite ? { ...options, forceRemoteOverwrite: true } : options;
			return profile
				? await this.pullFileFromBitableProfile(file, profile, nextOptions)
				: await this.pullFileFromBitable(file, nextOptions);
		};
		const recordBothConflict = async (direction: SyncDirection, error: string): Promise<void> => {
			this.syncState.upsert({
				filePath: file.path,
				title: file.basename,
				content: rawContent,
				docToken: docToken || undefined,
				url: feishuUrl || undefined,
				bitableRecordId: bitableRecordId || undefined,
				bitableProfileId: profile?.id,
				bitableAppToken: bitableAppToken || undefined,
				bitableTableId: bitableTableId || undefined,
				bitableViewId,
				direction,
				status: 'conflict',
				error,
				remoteHash: bitableRemoteHash,
				remoteRevision: remoteMeta?.revision,
				remoteUpdatedAt: Math.max(remoteMeta?.updatedAt || 0, bitableUpdatedAt || 0) || undefined,
				docRemoteRevision: remoteMeta?.revision,
				docRemoteUpdatedAt: remoteMeta?.updatedAt,
				bitableRemoteHash,
				bitableRemoteUpdatedAt: bitableUpdatedAt
			});
			await this.saveSettings();
		};
		const plan = planSmartSyncBoth(
			{
				mapped: !!feishuUrl,
				hasBaseline: feishuEvaluation.hasBaseline,
				hasLocalChanges: feishuEvaluation.hasLocalChanges,
				hasRemoteChanges: feishuEvaluation.hasRemoteChanges
			},
			{
				mapped: !!bitableRecordId,
				hasBaseline: bitableEvaluation.hasBaseline,
				hasLocalChanges: bitableEvaluation.hasLocalChanges,
				hasRemoteChanges: bitableEvaluation.hasRemoteChanges
			}
		);

		if (plan.action === 'create-all') {
			if (!silent) {
				new Notice('未找到飞书文档或多维表格映射，正在创建完整同步');
			}
			return await this.shareFile(file, { syncTargetOverride: 'both', silent });
		}
		if (plan.action === 'push-all') {
			return await this.shareFile(file, {
				...(feishuUrl ? { forceUpdateUrl: feishuUrl } : {}),
				syncTargetOverride: 'both',
				silent
			});
		}
		if (plan.action === 'pull-feishu') {
			return (await this.updateFromFeishu(file, options)) && (await this.syncBothTargetsFromLocal(file, options));
		}
		if (plan.action === 'pull-bitable') {
			return (await pullBitableTarget()) && (await this.syncBothTargetsFromLocal(file, options));
		}
		if (plan.action === 'choose-remote-source') {
			if (!interactive) {
				await recordBothConflict('obsidian-to-feishu', `${syncLabel}检测到飞书文档和多维表格都存在远端改动，已跳过`);
				this.log(`${syncLabel} skipped dual-remote conflict for ${file.path}`, 'warn');
				return false;
			}
			const choice = await this.chooseBothRemoteSourceAction(file.basename);
			if (choice === 'feishu') {
				return (await this.updateFromFeishu(file, options)) && (await this.syncBothTargetsFromLocal(file, options));
			}
			if (choice === 'bitable') {
				return (await pullBitableTarget()) && (await this.syncBothTargetsFromLocal(file, options));
			}
			await recordBothConflict('obsidian-to-feishu', '智能同步检测到飞书文档和多维表格均有远端改动，用户取消');
			if (!silent) {
				new Notice('已取消：飞书文档和多维表格都存在远端改动');
			}
			return false;
		}
		if (plan.action === 'choose-local-vs-feishu' || plan.action === 'choose-local-vs-bitable') {
			const preferredRemoteUpdatedAt = plan.action === 'choose-local-vs-bitable'
				? bitableUpdatedAt
				: remoteMeta?.updatedAt;
			if (this.shouldAutoPullRemoteVersion(file, preferredRemoteUpdatedAt)) {
				if (plan.action === 'choose-local-vs-bitable') {
					if (!await pullBitableTarget(true)) {
						return false;
					}
				} else {
					if (!await this.updateFromFeishu(file, { ...options, forceRemoteOverwrite: true })) {
						return false;
					}
				}
				return await this.syncBothTargetsFromLocal(file, options);
			}
			if (!interactive) {
				await recordBothConflict(
					plan.action === 'choose-local-vs-bitable' ? 'bitable' : 'obsidian-to-feishu',
					`${syncLabel}检测到 ${plan.reason}，已跳过`
				);
				this.log(`${syncLabel} skipped local-vs-remote conflict for ${file.path}`, 'warn');
				return false;
			}
			const choice = await this.chooseSmartSyncConflictAction(file.basename);
			if (choice === 'cancel') {
				await recordBothConflict(
					plan.action === 'choose-local-vs-bitable' ? 'bitable' : 'obsidian-to-feishu',
					`智能同步检测到 ${plan.reason}，用户取消`
				);
				if (!silent) {
					new Notice(`已取消：${plan.reason}`);
				}
				return false;
			}
			if (choice === 'pull') {
				if (plan.action === 'choose-local-vs-bitable') {
					if (!await pullBitableTarget()) {
						return false;
					}
				} else {
					if (!await this.updateFromFeishu(file, options)) {
						return false;
					}
				}
				return await this.syncBothTargetsFromLocal(file, options);
			}
			return await this.shareFile(file, {
				...(feishuUrl ? { forceUpdateUrl: feishuUrl } : {}),
				syncTargetOverride: 'both',
				silent
			});
		}
		if (!silent) {
			new Notice('✅ 本地、飞书文档和多维表格已是最新');
		}
		return true;
	}

	async syncCurrentNote(): Promise<void> {
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile || activeFile.extension !== 'md') {
			new Notice('❌ 没有打开的 Markdown 笔记');
			return;
		}
		await this.shareFile(activeFile);
	}

	async batchSyncNotes(): Promise<void> {
		const files = this.getBatchSyncFiles();
		if (!files || files.length === 0) {
			new Notice('❌ 未找到可同步的文件');
			return;
		}
		const statusNotice = this.settings.suppressShareNotices ? undefined : new Notice(`🔄 批量同步中(0/${files.length})...`, 0);
		let successCount = 0;
		let failedCount = 0;
		try {
			for (let i = 0; i < files.length; i++) {
				statusNotice?.setMessage(`🔄 批量同步中(${i + 1}/${files.length})...`);
				try {
					const ok = await this.shareFile(files[i]);
					if (ok) {
						successCount++;
					} else {
						failedCount++;
					}
				} catch (error) {
					failedCount++;
					this.log(`Batch sync failed for ${files[i].path}: ${(error as Error)?.message || String(error)}`, 'warn');
				}
			}
		} finally {
			statusNotice?.hide();
		}
		if (!this.settings.suppressShareNotices) {
			new Notice(`✅ 批量同步完成：成功 ${successCount}，失败 ${failedCount}`);
		}
	}

	async batchSmartSyncNotes(): Promise<void> {
		const files = this.getBatchSyncFiles();
		if (!files || files.length === 0) {
			new Notice('❌ 未找到可同步的文件');
			return;
		}
		const statusNotice = this.settings.suppressShareNotices ? undefined : new Notice(`🔄 智能同步中(0/${files.length})...`, 0);
		let successCount = 0;
		let failedCount = 0;
		try {
			for (let i = 0; i < files.length; i++) {
				statusNotice?.setMessage(`🔄 智能同步中(${i + 1}/${files.length})...`);
				try {
					const ok = await this.smartSyncFile(files[i]);
					if (ok) {
						successCount++;
					} else {
						failedCount++;
					}
				} catch (error) {
					failedCount++;
					this.log(`Smart sync failed for ${files[i].path}: ${(error as Error)?.message || String(error)}`, 'warn');
				}
			}
		} finally {
			statusNotice?.hide();
		}
		if (!this.settings.suppressShareNotices) {
			new Notice(`✅ 智能同步完成：成功 ${successCount}，失败 ${failedCount}`);
		}
	}

	/**
	 * 注册右键菜单
	 */
	private registerMenus(): void {
		// 添加文件右键菜单
		this.registerEvent(
			this.app.workspace.on('file-menu', (menu: Menu, file: TFile) => {
				if (file instanceof TFile && file.extension === 'md') {
					menu.addItem((item) => {
						item
							.setTitle('🔄 智能双向同步')
							.setIcon('refresh-cw')
							.onClick(() => {
								this.smartSyncFile(file);
							});
					});
					menu.addItem((item) => {
						item
							.setTitle('📤 分享到飞书')
							.setIcon('share')
							.onClick(() => {
								this.shareFile(file);
							});
					});
					menu.addItem((item) => {
						item
							.setTitle('⬇️ 从飞书更新')
							.setIcon('download')
							.onClick(() => {
								this.updateFromFeishu(file);
							});
					});
					menu.addItem((item) => {
						item
							.setTitle('⬆️ 覆盖到已有飞书文档')
							.setIcon('upload')
							.onClick(() => {
								this.overwriteToFeishu(file);
							});
					});
				}
			})
		);

		// 添加编辑器右键菜单
		this.registerEvent(
			this.app.workspace.on('editor-menu', (menu: Menu, editor: Editor, view: MarkdownView) => {
				menu.addItem((item) => {
					item
						.setTitle('🔄 智能双向同步')
						.setIcon('refresh-cw')
						.onClick(() => {
							const activeFile = this.app.workspace.getActiveFile();
							if (activeFile) {
								this.smartSyncFile(activeFile);
							}
						});
				});
				menu.addItem((item) => {
					item
						.setTitle('📤 分享到飞书')
						.setIcon('share')
						.onClick(() => {
							this.shareCurrentNote();
						});
				});
				menu.addItem((item) => {
					item
						.setTitle('⬇️ 从飞书更新')
						.setIcon('download')
						.onClick(() => {
							const activeFile = this.app.workspace.getActiveFile();
							if (activeFile) {
								this.updateFromFeishu(activeFile);
							}
						});
				});
				menu.addItem((item) => {
					item
						.setTitle('⬆️ 覆盖到已有飞书文档')
						.setIcon('upload')
						.onClick(() => {
							const activeFile = this.app.workspace.getActiveFile();
							if (activeFile) {
								this.overwriteToFeishu(activeFile);
							}
						});
				});
			})
		);
	}

	private async updateFromFeishu(file: TFile, options?: SyncExecutionOptions): Promise<boolean> {
		const interactive = options?.interactive !== false;
		const silent = options?.silent === true;
		const forceRemoteOverwrite = options?.forceRemoteOverwrite === true;
		const statusNotice = (silent || this.settings.suppressShareNotices) ? undefined : new Notice('⬇️ 正在从飞书更新...', 0);
		try {
			if (!file || file.extension !== 'md') {
				statusNotice?.hide();
				if (!silent) {
					new Notice('❌ 只支持 Markdown 文件');
				}
				return false;
			}
			if (!this.settings.accessToken || !this.settings.userInfo) {
				statusNotice?.hide();
				if (!silent) {
					new Notice('❌ 请先在设置中完成飞书授权');
				}
				return false;
			}

			const extractLinkFromFrontMatter = (raw: string): string => {
				try {
					if (!raw || (!raw.startsWith('---\n') && !raw.startsWith('---\r\n'))) {
						return '';
					}
					const lines = raw.split('\n');
					let endIndex = -1;
					for (let i = 1; i < lines.length; i++) {
						if (lines[i].trim() === '---') {
							endIndex = i;
							break;
						}
					}
					if (endIndex === -1) return '';
					for (let i = 1; i < endIndex; i++) {
						const line = (lines[i] || '').trim();
						if (!line || line.startsWith('#')) continue;
						const m = line.match(/^link\s*:\s*(.+)\s*$/);
						if (!m) continue;
						let v = String(m[1] || '').trim();
						v = v.replace(/^["'“”‘’`]+/, '').replace(/["'“”‘’`]+$/, '').trim();
						return v;
					}
					return '';
				} catch {
					return '';
				}
			};

			const rawContent = await this.app.vault.read(file);
			const tokenOk = await this.feishuApi.ensureValidTokenWithReauth(statusNotice);
			if (!tokenOk) {
				statusNotice?.hide();
				if (!silent) {
					new Notice('❌ 授权未完成，请重试');
				}
				return false;
			}

			const history = Array.isArray(this.settings.uploadHistory) ? this.settings.uploadHistory : [];
			const hit = history.find((h) => h && h.filePath === file.path);
			const directUrl = hit
				? (hit.url || (hit.docToken ? `https://feishu.cn/docx/${hit.docToken}` : ''))
				: '';

			const fmLink = extractLinkFromFrontMatter(rawContent);
			let url = directUrl || fmLink;
			if (!url) {
				statusNotice?.hide();
				if (silent || !interactive) {
					this.log(`Skipping pull from Feishu for ${file.path}: missing mapped URL`, 'warn');
					return false;
				}
				const pasted = await this.promptFeishuUrlForOverwrite();
				if (!pasted) {
					return false;
				}
				url = pasted;
				if (statusNotice) {
					statusNotice.setMessage('⬇️ 正在从飞书更新...');
				}
			}

			statusNotice?.setMessage('🔍 正在解析文档链接...');
			const docId = this.feishuApi.extractDocumentIdFromUrl(url);
			if (!docId) {
				throw new Error('无法从链接中提取文档ID');
			}

			const remoteMeta = await this.feishuApi.getDocumentMeta(docId);

			statusNotice?.setMessage('📥 正在获取云端内容...');
			const blocks = await this.feishuApi.getAllDocumentBlocks(docId);
			if (!Array.isArray(blocks) || blocks.length === 0) {
				throw new Error('获取云端文档块失败或为空');
			}

			statusNotice?.setMessage('🧩 正在转换为 Markdown...');
			let md = DocxBlocksToMarkdown.convert(blocks, { app: this.app });

			const localChange = this.syncState.getLocalChange(file.path, rawContent);
			if (localChange.hasLocalChanges) {
				if (forceRemoteOverwrite) {
					statusNotice?.setMessage('💾 正在写入本地文件...');
				} else if (!interactive) {
					this.syncState.upsert({
						filePath: file.path,
						title: file.basename,
						content: rawContent,
						docToken: this.extractDocTokenFromUrl(url) || undefined,
						url,
						direction: 'feishu-to-obsidian',
						status: 'conflict',
						error: '定时同步检测到本地存在未同步改动，已跳过飞书覆盖',
						remoteRevision: remoteMeta?.revision,
						remoteUpdatedAt: remoteMeta?.updatedAt
					});
					await this.saveSettings();
					this.log(`Scheduled sync skipped Feishu overwrite for ${file.path}`, 'warn');
					return false;
				}
				statusNotice?.hide();
				const shouldOverwrite = await this.confirmOverwriteLocalChanges(file.basename, localChange.lastHash || '', localChange.currentHash, '飞书');
				if (!shouldOverwrite) {
					this.syncState.upsert({
						filePath: file.path,
						title: file.basename,
						content: rawContent,
						docToken: this.extractDocTokenFromUrl(url) || undefined,
						url,
						direction: 'feishu-to-obsidian',
						status: 'conflict',
						error: '用户取消从飞书覆盖本地改动',
						remoteRevision: remoteMeta?.revision,
						remoteUpdatedAt: remoteMeta?.updatedAt
					});
					await this.saveSettings();
					if (!silent) {
						new Notice('已取消：本地内容有未同步改动');
					}
					return false;
				}
				if (statusNotice) {
					statusNotice.setMessage('💾 正在写入本地文件...');
				}
			}

			md = await this.localizeFeishuMediaBlocks(md, blocks, file.basename, statusNotice, silent);
			statusNotice?.setMessage('💾 正在写入本地文件...');
			const withShareMark = this.markdownProcessor.addShareMarkToFrontMatter(md, url, (file.stat as any)?.ctime, file.basename);
			const backupPath = await this.backupBeforeRemoteOverwrite(file, rawContent, 'Feishu Docx');
			await this.app.vault.modify(file, withShareMark);

			// best-effort 维护映射（供后续免弹窗/双链替换等使用）
			try {
				const docToken = this.extractDocTokenFromUrl(url) || undefined;
				const now = Date.now();
				const history = Array.isArray(this.settings.uploadHistory) ? this.settings.uploadHistory : [];
				const idx = history.findIndex((h) => h && h.filePath === file.path);
				const existing = idx >= 0 ? history[idx] : null;
				const item = {
					filePath: file.path,
					title: file.basename,
					docToken: docToken || (existing && existing.docToken ? String(existing.docToken) : undefined),
					url,
					bitableRecordId: existing && existing.bitableRecordId ? existing.bitableRecordId : undefined,
					updatedAt: now
				};
				if (idx >= 0) {
					history[idx] = { ...history[idx], ...item };
				} else {
					history.unshift(item);
				}
				this.settings.uploadHistory = history;
				this.syncState.upsert({
					filePath: file.path,
					title: file.basename,
					content: withShareMark,
					docToken: docToken || undefined,
					url,
					bitableRecordId: item.bitableRecordId,
					direction: 'feishu-to-obsidian',
					remoteRevision: remoteMeta?.revision,
					remoteUpdatedAt: remoteMeta?.updatedAt
				});
				await this.saveSettings();
			} catch (e) {
				console.warn('[feishu-share] Failed to update uploadHistory after updateFromFeishu (ignored)', e);
			}
			statusNotice?.hide();
			if (!silent) {
				new Notice(backupPath ? `✅ 已从飞书更新并覆盖本地文件\n备份：${backupPath}` : '✅ 已从飞书更新并覆盖本地文件');
			}
			return true;
		} catch (e) {
			statusNotice?.hide();
			await this.recordSyncError(file, 'feishu-to-obsidian', e, '从飞书更新');
			if (!silent) {
				this.handleError(e as Error, '从飞书更新');
			} else {
				this.log(`Pull from Feishu failed for ${file.path}: ${this.getErrorMessage(e)}`, 'warn');
			}
			return false;
		}
	}

	private async localizeFeishuMediaBlocks(markdown: string, blocks: any[], noteBaseName: string, statusNotice?: Notice, silent: boolean = false): Promise<string> {
		const mediaItems = this.collectFeishuMediaItems(blocks);
		if (!mediaItems.length) {
			return markdown;
		}

		const folder = this.normalizeVaultPath(`Feishu Attachments/${this.sanitizeFileName(noteBaseName || 'Untitled')}`);
		await this.ensureVaultFolder(folder);

		let localized = markdown;
		let failedCount = 0;
		for (let i = 0; i < mediaItems.length; i++) {
			const item = mediaItems[i];
			try {
				statusNotice?.setMessage(`📎 正在下载飞书附件 ${i + 1}/${mediaItems.length}...`);
				const data = await this.feishuApi.downloadMediaFromFeishu(item.token);
				const attachmentPath = await this.createUniqueAttachmentPath(folder, item.fileName);
				await this.app.vault.adapter.writeBinary(attachmentPath, data);
				localized = this.replaceMediaTokenInMarkdown(localized, item, attachmentPath);
			} catch (error) {
				failedCount++;
				this.log(`Failed to download Feishu media ${item.token}: ${(error as Error)?.message || String(error)}`, 'warn');
			}
		}

		if (!silent && failedCount > 0) {
			new Notice(`⚠️ ${failedCount} 个飞书附件下载失败，已保留原始 token 链接`);
		}
		return localized;
	}

	private collectFeishuMediaItems(blocks: any[]): Array<{ token: string; fileName: string; isImage: boolean; label: string }> {
		const items: Array<{ token: string; fileName: string; isImage: boolean; label: string }> = [];
		const seen = new Set<string>();
		(blocks || []).forEach((block, index) => {
			const type = Number(block?.block_type || block?.blockType || 0);
			if (type === 27) {
				const image = block?.image || {};
				const token = String(image.token || '').trim();
				if (!token || seen.has(token)) {
					return;
				}
				seen.add(token);
				const rawName = String(image.name || image.file_name || image.filename || `image-${index + 1}`).trim();
				const mime = String(image.mime_type || image.mimeType || '').trim();
				items.push({
					token,
					fileName: this.ensureImageFileExtension(this.sanitizeFileName(rawName), mime),
					isImage: true,
					label: ''
				});
				return;
			}

			if (type === 23) {
				const file = block?.file || {};
				const token = String(file.token || '').trim();
				if (!token || seen.has(token)) {
					return;
				}
				seen.add(token);
				const rawName = String(file.name || file.file_name || file.filename || `attachment-${index + 1}`).trim();
				const fileName = this.sanitizeFileName(rawName);
				items.push({
					token,
					fileName,
					isImage: false,
					label: rawName || fileName
				});
			}
		});
		return items;
	}

	private replaceMediaTokenInMarkdown(markdown: string, item: { token: string; isImage: boolean; label: string }, attachmentPath: string): string {
		const tokenPattern = this.escapeRegExp(item.token);
		const linkedPath = this.escapeMarkdownLinkTarget(attachmentPath);
		if (item.isImage) {
			return markdown.replace(new RegExp(`!\\[([^\\]]*)\\]\\(${tokenPattern}\\)`, 'g'), `![$1](${linkedPath})`);
		}
		return markdown.replace(new RegExp(`\\[([^\\]]*)\\]\\(${tokenPattern}\\)`, 'g'), `[$1](${linkedPath})`);
	}

	private async ensureVaultFolder(folder: string): Promise<void> {
		const adapter = this.app.vault.adapter;
		const parts = this.normalizeVaultPath(folder).split('/').filter(Boolean);
		let current = '';
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			if (!(await adapter.exists(current))) {
				await adapter.mkdir(current);
			}
		}
	}

	private async createUniqueAttachmentPath(folder: string, fileName: string): Promise<string> {
		const safeName = this.sanitizeFileName(fileName || 'attachment');
		const dotIndex = safeName.lastIndexOf('.');
		const baseName = dotIndex > 0 ? safeName.slice(0, dotIndex) : safeName;
		const extension = dotIndex > 0 ? safeName.slice(dotIndex) : '';
		let candidate = this.normalizeVaultPath(`${folder}/${safeName}`);
		let counter = 1;
		while (await this.app.vault.adapter.exists(candidate)) {
			candidate = this.normalizeVaultPath(`${folder}/${baseName}-${counter}${extension}`);
			counter++;
		}
		return candidate;
	}

	private async backupBeforeRemoteOverwrite(file: TFile, content: string, sourceName: string): Promise<string | null> {
		if (this.settings.enableOverwriteBackup === false) {
			return null;
		}
		const now = new Date();
		const folder = this.normalizeVaultPath(`Feishu Backups/${this.sanitizeFileName(sourceName || 'remote')}/${this.formatBackupDate(now)}`);
		await this.ensureVaultFolder(folder);
		const baseName = this.sanitizeFileName(file.path.replace(/\//g, '__').replace(/\.md$/i, '') || file.basename);
		const fileName = `${this.formatBackupTimestamp(now)}-${baseName}.md`;
		const backupPath = await this.createUniqueAttachmentPath(folder, fileName);
		await this.app.vault.adapter.write(backupPath, content);
		return backupPath;
	}

	private formatBackupDate(date: Date): string {
		const yyyy = date.getFullYear();
		const mm = String(date.getMonth() + 1).padStart(2, '0');
		const dd = String(date.getDate()).padStart(2, '0');
		return `${yyyy}-${mm}-${dd}`;
	}

	private formatBackupTimestamp(date: Date): string {
		const hh = String(date.getHours()).padStart(2, '0');
		const mm = String(date.getMinutes()).padStart(2, '0');
		const ss = String(date.getSeconds()).padStart(2, '0');
		return `${hh}${mm}${ss}`;
	}

	private ensureImageFileExtension(fileName: string, mimeType: string): string {
		if (/\.[a-z0-9]{2,8}$/i.test(fileName)) {
			return fileName;
		}
		const mime = mimeType.toLowerCase();
		if (mime.includes('jpeg') || mime.includes('jpg')) return `${fileName}.jpg`;
		if (mime.includes('gif')) return `${fileName}.gif`;
		if (mime.includes('webp')) return `${fileName}.webp`;
		if (mime.includes('svg')) return `${fileName}.svg`;
		if (mime.includes('bmp')) return `${fileName}.bmp`;
		return `${fileName}.png`;
	}

	private sanitizeFileName(name: string): string {
		const cleaned = String(name || 'attachment')
			.trim()
			.replace(/[<>:"/\\|?*#()[\]\r\n\t]/g, '_')
			.replace(/\s+/g, ' ')
			.replace(/^\.+/, '')
			.replace(/\.+$/, '')
			.trim();
		return cleaned || 'attachment';
	}

	private normalizeVaultPath(path: string): string {
		return normalizePath(String(path || '').replace(/\\/g, '/')).replace(/^\/+/, '');
	}

	private escapeMarkdownLinkTarget(path: string): string {
		return this.normalizeVaultPath(path).replace(/ /g, '%20');
	}

	private escapeRegExp(value: string): string {
		return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	}

	private getFeishuUrlForFile(file: TFile, rawContent: string): string {
		const history = Array.isArray(this.settings.uploadHistory) ? this.settings.uploadHistory : [];
		const hit = history.find((h) => h && h.filePath === file.path);
		const directUrl = hit
			? (hit.url || (hit.docToken ? `https://feishu.cn/docx/${hit.docToken}` : ''))
			: '';
		if (directUrl) {
			return directUrl;
		}
		try {
			if (!rawContent || (!rawContent.startsWith('---\n') && !rawContent.startsWith('---\r\n'))) {
				return '';
			}
			const lines = rawContent.split('\n');
			let endIndex = -1;
			for (let i = 1; i < lines.length; i++) {
				if (lines[i].trim() === '---') {
					endIndex = i;
					break;
				}
			}
			if (endIndex === -1) return '';
			for (let i = 1; i < endIndex; i++) {
				const line = (lines[i] || '').trim();
				if (!line || line.startsWith('#')) continue;
				const m = line.match(/^link\s*:\s*(.+)\s*$/);
				if (!m) continue;
				let v = String(m[1] || '').trim();
				v = v.replace(/^["'“”‘’`]+/, '').replace(/["'“”‘’`]+$/, '').trim();
				return v;
			}
		} catch {
			return '';
		}
		return '';
	}

	private async overwriteToFeishu(file: TFile): Promise<void> {
		try {
			if (!file || file.extension !== 'md') {
				new Notice('❌ 只支持 Markdown 文件');
				return;
			}
			const history = Array.isArray(this.settings.uploadHistory) ? this.settings.uploadHistory : [];
			const hit = history.find((h) => h && h.filePath === file.path);
			const directUrl = hit
				? (hit.url || (hit.docToken ? `https://feishu.cn/docx/${hit.docToken}` : ''))
				: '';

			if (directUrl) {
				await this.shareFile(file, { forceUpdateUrl: directUrl });
				return;
			}

			const pasted = await this.promptFeishuUrlForOverwrite();
			if (!pasted) {
				return;
			}
			await this.shareFile(file, { forceUpdateUrl: pasted });
		} catch (e) {
			this.handleError(e as Error, '从飞书覆盖');
		}
	}

	private async confirmOverwriteLocalChanges(title: string, lastHash: string, currentHash: string, sourceName: string = '飞书'): Promise<boolean> {
		return await new Promise((resolve) => {
			const source = sourceName || '飞书';
			class ConflictConfirmModal extends Modal {
				private resolved = false;

				onOpen(): void {
					const { contentEl } = this;
					contentEl.empty();
					contentEl.addClass('feishu-conflict-confirm-modal');
					contentEl.createEl('style', {
						text: `
							.feishu-conflict-confirm-modal{padding:0;}
							.feishu-conflict-confirm-wrap{padding:18px 18px 16px;}
							.feishu-conflict-confirm-title{margin:0 0 8px;font-size:20px;font-weight:700;}
							.feishu-conflict-confirm-desc{margin:0 0 12px;line-height:1.55;opacity:.9;}
							.feishu-conflict-confirm-meta{margin:0 0 14px;font-size:12px;opacity:.7;font-family:var(--font-monospace);}
							.feishu-conflict-confirm-actions{display:flex;justify-content:flex-end;gap:8px;}
						`
					});
					const wrap = contentEl.createDiv({ cls: 'feishu-conflict-confirm-wrap' });
					wrap.createEl('h3', { text: '本地内容有未同步改动', cls: 'feishu-conflict-confirm-title' });
					wrap.createEl('p', {
						text: `“${title}” 自上次同步后已在 Obsidian 中修改。从${source}更新会覆盖当前本地内容。`,
						cls: 'feishu-conflict-confirm-desc'
					});
					wrap.createEl('div', {
						text: `last=${lastHash || 'none'} current=${currentHash}`,
						cls: 'feishu-conflict-confirm-meta'
					});
					const btnRow = wrap.createDiv({ cls: 'feishu-conflict-confirm-actions' });
					const cancelBtn = btnRow.createEl('button', { text: '取消' });
					const overwriteBtn = btnRow.createEl('button', { text: '继续覆盖', cls: 'mod-warning' });
					cancelBtn.onclick = () => {
						this.resolved = true;
						this.close();
						resolve(false);
					};
					overwriteBtn.onclick = () => {
						this.resolved = true;
						this.close();
						resolve(true);
					};
				}

				onClose(): void {
					this.contentEl.empty();
					if (!this.resolved) {
						resolve(false);
					}
				}
			}
			new ConflictConfirmModal(this.app).open();
		});
	}

	private async chooseSmartSyncConflictAction(title: string): Promise<'push' | 'pull' | 'cancel'> {
		return await new Promise((resolve) => {
			class SmartSyncConflictModal extends Modal {
				private resolved = false;

				onOpen(): void {
					const { contentEl } = this;
					contentEl.empty();
					contentEl.addClass('feishu-smart-sync-conflict-modal');
					contentEl.createEl('style', {
						text: `
							.feishu-smart-sync-conflict-modal{padding:0;}
							.feishu-smart-sync-conflict-wrap{padding:18px 18px 16px;}
							.feishu-smart-sync-conflict-title{margin:0 0 8px;font-size:20px;font-weight:700;}
							.feishu-smart-sync-conflict-desc{margin:0 0 14px;line-height:1.55;opacity:.9;}
							.feishu-smart-sync-conflict-actions{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;}
						`
					});
					const wrap = contentEl.createDiv({ cls: 'feishu-smart-sync-conflict-wrap' });
					wrap.createEl('h3', { text: '检测到双向改动', cls: 'feishu-smart-sync-conflict-title' });
					wrap.createEl('p', {
						text: `“${title}” 在 Obsidian 和飞书两侧都有新改动。请选择这次同步保留哪一侧。`,
						cls: 'feishu-smart-sync-conflict-desc'
					});
					const btnRow = wrap.createDiv({ cls: 'feishu-smart-sync-conflict-actions' });
					const cancelBtn = btnRow.createEl('button', { text: '取消' });
					const pullBtn = btnRow.createEl('button', { text: '使用飞书覆盖本地' });
					const pushBtn = btnRow.createEl('button', { text: '使用本地覆盖飞书', cls: 'mod-cta' });
					cancelBtn.onclick = () => {
						this.resolved = true;
						this.close();
						resolve('cancel');
					};
					pullBtn.onclick = () => {
						this.resolved = true;
						this.close();
						resolve('pull');
					};
					pushBtn.onclick = () => {
						this.resolved = true;
						this.close();
						resolve('push');
					};
				}

				onClose(): void {
					this.contentEl.empty();
					if (!this.resolved) {
						resolve('cancel');
					}
				}
			}
			new SmartSyncConflictModal(this.app).open();
		});
	}

	private async chooseBothRemoteSourceAction(title: string): Promise<'feishu' | 'bitable' | 'cancel'> {
		return await new Promise((resolve) => {
			class BothRemoteConflictModal extends Modal {
				private resolved = false;

				onOpen(): void {
					const { contentEl } = this;
					contentEl.empty();
					contentEl.addClass('feishu-smart-sync-conflict-modal');
					contentEl.createEl('style', {
						text: `
							.feishu-smart-sync-conflict-modal{padding:0;}
							.feishu-smart-sync-conflict-wrap{padding:18px 18px 16px;}
							.feishu-smart-sync-conflict-title{margin:0 0 8px;font-size:20px;font-weight:700;}
							.feishu-smart-sync-conflict-desc{margin:0 0 14px;line-height:1.55;opacity:.9;}
							.feishu-smart-sync-conflict-actions{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;}
						`
					});
					const wrap = contentEl.createDiv({ cls: 'feishu-smart-sync-conflict-wrap' });
					wrap.createEl('h3', { text: '检测到两个远端都有改动', cls: 'feishu-smart-sync-conflict-title' });
					wrap.createEl('p', {
						text: `“${title}” 的飞书文档和多维表格记录都有新改动。请选择这次同步以哪一侧远端为准。`,
						cls: 'feishu-smart-sync-conflict-desc'
					});
					const btnRow = wrap.createDiv({ cls: 'feishu-smart-sync-conflict-actions' });
					const cancelBtn = btnRow.createEl('button', { text: '取消' });
					const bitableBtn = btnRow.createEl('button', { text: '使用多维表格覆盖本地' });
					const feishuBtn = btnRow.createEl('button', { text: '使用飞书文档覆盖本地', cls: 'mod-cta' });
					cancelBtn.onclick = () => {
						this.resolved = true;
						this.close();
						resolve('cancel');
					};
					feishuBtn.onclick = () => {
						this.resolved = true;
						this.close();
						resolve('feishu');
					};
					bitableBtn.onclick = () => {
						this.resolved = true;
						this.close();
						resolve('bitable');
					};
				}

				onClose(): void {
					this.contentEl.empty();
					if (!this.resolved) {
						resolve('cancel');
					}
				}
			}
			new BothRemoteConflictModal(this.app).open();
		});
	}

	private async promptFeishuUrlForOverwrite(): Promise<string | null> {
		return await new Promise((resolve) => {
			const plugin = this;
			class FeishuUrlPromptModal extends Modal {
				private value: string = '';

				onOpen(): void {
					const { contentEl } = this;
					contentEl.empty();
					contentEl.addClass('feishu-url-prompt-modal');
					contentEl.createEl('style', {
						text: `
							.feishu-url-prompt-modal{padding:0;}
							.feishu-url-prompt-wrap{padding:18px 18px 16px;}
							.feishu-url-prompt-title{margin:0 0 8px;font-size:22px;font-weight:700;}
							.feishu-url-prompt-desc{margin:0 0 10px;opacity:.8;}
							.feishu-url-prompt-textarea{width:100%;box-sizing:border-box;min-height:92px;resize:vertical;}
							.feishu-url-prompt-actions{display:flex;gap:10px;justify-content:center;margin-top:14px;}
						`
					});

					const wrap = contentEl.createDiv({ cls: 'feishu-url-prompt-wrap' });
					wrap.createEl('h2', { text: '粘贴飞书文档链接', cls: 'feishu-url-prompt-title' });
					wrap.createEl('div', { text: '支持粘贴 docx 链接或 docToken。', cls: 'feishu-url-prompt-desc' });
					const textarea = wrap.createEl('textarea', {
						attr: {
							rows: '4',
							placeholder: 'https://feishu.cn/docx/xxxx 或直接粘贴 token'
						}
					});
					textarea.addClass('mod-align-left');
					textarea.addClass('feishu-url-prompt-textarea');
					textarea.addEventListener('input', () => {
						this.value = textarea.value;
					});

					const btnRow = wrap.createDiv({ cls: 'feishu-url-prompt-actions' });
					const okBtn = btnRow.createEl('button', { text: '确定', cls: 'mod-cta' });
					const cancelBtn = btnRow.createEl('button', { text: '取消' });

					okBtn.onclick = () => {
						const raw = (this.value || '').trim();
						const token = plugin.extractDocTokenFromUrl(raw);
						const url = token ? `https://feishu.cn/docx/${token}` : raw;
						this.close();
						if (!url) {
							new Notice('❌ 请输入有效的飞书链接或 token');
							resolve(null);
							return;
						}
						resolve(url);
					};
					cancelBtn.onclick = () => {
						this.close();
						resolve(null);
					};
				}

				onClose(): void {
					this.contentEl.empty();
				}
			}
			new FeishuUrlPromptModal(this.app).open();
		});
	}

	async loadSettings(): Promise<void> {
		const loadedData = await this.loadData();
		this.settings = Object.assign({}, DEFAULT_SETTINGS, loadedData);
		this.settings.bitableProfiles = mergeDefaultBitableProfiles(this.settings.bitableProfiles);
		if (!this.settings.activeBitableProfileId || !this.settings.bitableProfiles.some((profile) => profile.id === this.settings.activeBitableProfileId)) {
			this.settings.activeBitableProfileId = this.settings.bitableProfiles[0]?.id || '';
		}
		if (!Array.isArray(this.settings.scheduledBitableProfileIds)) {
			this.settings.scheduledBitableProfileIds = [DEFAULT_IOTO_TASK_PROFILE.id];
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		if (this.feishuApi) {
			this.feishuApi.updateSettings(this.settings);
		}
		if (this.syncState) {
			this.syncState.updateSettings(this.settings);
		}
		this.configureScheduledSync(true);
	}

	/**
	 * 处理OAuth回调
	 */
	private async handleOAuthCallback(params: Record<string, string>): Promise<void> {
		this.log('Processing OAuth callback');

		if (params.code) {
			new Notice('🔄 正在处理授权回调...');

			try {
				const success = await this.feishuApi.processCallback(`obsidian://feishu-auth?${new URLSearchParams(params).toString()}`);

				if (success) {
					this.log('OAuth authorization successful');
					new Notice('🎉 自动授权成功！');
					await this.saveSettings();

					// 通知设置页面刷新和分享流程继续 - 使用自定义事件
					window.dispatchEvent(new CustomEvent('feishu-auth-success', {
						detail: {
							timestamp: Date.now(),
							source: 'oauth-callback'
						}
					}));
				} else {
					this.log('OAuth authorization failed', 'warn');
					new Notice('❌ 授权处理失败，请重试');
				}
			} catch (error) {
				this.handleError(error as Error, 'OAuth回调处理');
			}
		} else if (params.error) {
			const errorMsg = params.error_description || params.error;
			this.log(`OAuth error: ${errorMsg}`, 'error');
			new Notice(`❌ 授权失败: ${errorMsg}`);
		} else {
			this.log('Invalid OAuth callback parameters', 'warn');
			new Notice('❌ 无效的授权回调');
		}
	}

	/**
	 * 分享当前笔记
	 */
	async shareCurrentNote(): Promise<void> {
		this.log('Attempting to share current note');

		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile) {
			this.log('No active file found', 'warn');
			new Notice('❌ 没有打开的笔记');
			return;
		}

		if (activeFile.extension !== 'md') {
			this.log(`Unsupported file type: ${activeFile.extension}`, 'warn');
			new Notice('❌ 只支持分享 Markdown 文件');
			return;
		}

		this.log(`Sharing file: ${activeFile.path}`);
		await this.shareFile(activeFile);
	}

	/**
	 * 分享指定文件
	 */
	async shareFile(file: TFile, options?: ShareFileOptions): Promise<boolean> {
		this.log(`Starting file share process for: ${file.path}`);
		const silent = options?.silent === true;

		// 创建持续状态提示（可抑制）
		const statusNotice = (silent || this.settings.suppressShareNotices) ? undefined : new Notice('🔄 正在分享到飞书...', 0); // 0表示不自动消失

		try {
			// 检查基本授权状态
			if (!this.settings.accessToken || !this.settings.userInfo) {
				this.log('Authorization required', 'warn');
				statusNotice?.hide();
				if (!silent) {
					new Notice('❌ 请先在设置中完成飞书授权');
				}
				return false;
			}

			// 确保文件已保存到磁盘
			this.log('Ensuring file is saved to disk');
			await this.ensureFileSaved(file);

			// 读取文件内容
			this.log('Reading file content');
			const rawContent = await this.app.vault.read(file);

			// 使用Markdown处理器处理内容（包含文件信息和Front Matter处理）
			const processResult = this.markdownProcessor.processCompleteWithFiles(
				rawContent,
				3, // maxDepth
				this.settings.frontMatterHandling,
				this.settings.enableSubDocumentUpload,
				this.settings.enableLocalImageUpload,
				this.settings.enableLocalAttachmentUpload,
				this.settings.titleSource,
				this.settings.codeBlockFilterLanguages || [],
				this.settings.uploadFileList || ''
			);

			// 同步/映射预处理（从 feishusync 迁入）：
			// - 规范缩进/任务列表
			// - 基于 uploadHistory 将 [[双链]] 替换为飞书 docx 裸链接
			// - 将 Markdown 链接转换为裸 URL，便于飞书自动识别
			const preprocessedForFeishu = this.markdownProcessor.preprocessContentForFeishu(
				processResult.content,
				this.settings.uploadHistory || [],
				'feishu.cn'
			);
			const processResultForFeishu = {
				...processResult,
				content: preprocessedForFeishu
			};

			// 根据设置提取文档标题
			const title = this.markdownProcessor.extractTitle(
				file.basename,
				processResult.frontMatter,
				this.settings.titleSource
			);
			const syncTarget = options?.syncTargetOverride || this.settings.syncTarget || 'docx';
			this.log(`Processing file with title: ${title}`);

			// 仅同步到多维表格：不创建/更新飞书云文档（docx）
			if (syncTarget === 'bitable') {
				await this.syncFileToBitable(file, title, rawContent, processResult, statusNotice, silent);
				statusNotice?.hide();
				return true;
			}

			// 检查是否为更新模式（存在feishushare标记）
			const updateModeFromFrontMatter = this.checkUpdateMode(processResult.frontMatter);
			const forcedUpdateUrl = (options && options.forceUpdateUrl) ? options.forceUpdateUrl : '';
			const isForcedUpdate = !!forcedUpdateUrl && !updateModeFromFrontMatter.shouldUpdate;
			const isUpdateMode = forcedUpdateUrl
				? { shouldUpdate: true, feishuUrl: forcedUpdateUrl }
				: updateModeFromFrontMatter;
			let result: ShareResult;
			let urlChanged = false;
			let bitableRecordIdForFile: string | undefined;

			if (isUpdateMode.shouldUpdate) {
				this.log(`Update mode detected for existing document: ${isUpdateMode.feishuUrl}`);
				statusNotice?.setMessage('🔍 检查现有文档可访问性...');

				// 检查现有URL是否可访问
				const urlAccessible = await this.feishuApi.checkDocumentUrlAccessibility(isUpdateMode.feishuUrl!);

				if (urlAccessible.isAccessible) {
					this.log('Existing document is accessible, updating content');
					statusNotice?.setMessage('🔄 正在更新现有文档...');

					// 调用更新现有文档的方法
					result = await this.feishuApi.updateExistingDocument(
						isUpdateMode.feishuUrl!,
						title,
						processResultForFeishu,
						statusNotice
					);
				} else if (urlAccessible.needsReauth) {
					this.log(`Token needs reauth, will retry after authorization: ${urlAccessible.error}`);
					statusNotice?.setMessage('🔑 需要重新授权，授权后将重试更新...');

					// 直接触发重新授权，不创建完整文档
					const authSuccess = await this.feishuApi.ensureValidTokenWithReauth(statusNotice);

					if (authSuccess) {
						this.log('Authorization completed, retrying original document access');
						statusNotice?.setMessage('🔄 重新检查原文档可访问性...');

						// 授权成功后，重新检查原文档可访问性
						const retryAccessible = await this.feishuApi.checkDocumentUrlAccessibility(isUpdateMode.feishuUrl!);

						if (retryAccessible.isAccessible) {
							this.log('Original document is now accessible after reauth, updating it');
							statusNotice?.setMessage('🔄 正在更新原文档...');

							// 直接更新原文档
							result = await this.feishuApi.updateExistingDocument(
								isUpdateMode.feishuUrl!,
								title,
								processResultForFeishu,
								statusNotice
							);
						} else {
							this.log(`Original document still not accessible after reauth: ${retryAccessible.error}, creating new document`);
							// 原文档仍不可访问，创建新文档
							result = await this.feishuApi.shareMarkdownWithFiles(title, processResultForFeishu, statusNotice);
							urlChanged = true;

							if (result.success) {
								this.log(`Document URL changed from ${isUpdateMode.feishuUrl} to ${result.url}`);
							}
						}
					} else {
						throw new Error('重新授权失败，请手动重新授权');
					}
				} else {
					this.log(`Existing document is not accessible: ${urlAccessible.error}, creating new document`);
					statusNotice?.setMessage('📄 原文档不可访问，正在创建新文档...');

					// 原文档不可访问，创建新文档
					result = await this.feishuApi.shareMarkdownWithFiles(title, processResultForFeishu, statusNotice);
					urlChanged = true;

					if (result.success) {
						this.log(`Document URL changed from ${isUpdateMode.feishuUrl} to ${result.url}`);
					}
				}
			} else {
				this.log('Normal share mode detected, creating new document');

				// 调用API分享（内部会自动检查和刷新token，如果需要重新授权会等待完成）
				result = await this.feishuApi.shareMarkdownWithFiles(title, processResultForFeishu, statusNotice);
			}

			// 隐藏状态提示
			statusNotice?.hide();

			if (result.success) {
				let remoteMeta: Awaited<ReturnType<FeishuApiService['getDocumentMeta']>> = null;
				let completed = true;
				// 维护 uploadHistory（本地文件 <-> 飞书文档映射），供同步/双链替换使用
				try {
					const url = result.url || '';
					const docToken = this.extractDocTokenFromUrl(url) || undefined;
					remoteMeta = docToken ? await this.feishuApi.getDocumentMeta(docToken) : null;
					const now = Date.now();
					const history = Array.isArray(this.settings.uploadHistory) ? this.settings.uploadHistory : [];
					const idx = history.findIndex((h) => h && h.filePath === file.path);
					const existing = idx >= 0 ? history[idx] : null;
					const item = {
						filePath: file.path,
						title,
						docToken: docToken || (existing && existing.docToken ? String(existing.docToken) : undefined),
						url,
						bitableRecordId: existing && existing.bitableRecordId ? existing.bitableRecordId : undefined,
						updatedAt: now
					};
					if (idx >= 0) {
						history[idx] = { ...history[idx], ...item };
					} else {
						history.unshift(item);
					}
					this.settings.uploadHistory = history;
					this.syncState.upsert({
						filePath: file.path,
						title,
						content: rawContent,
						docToken: item.docToken,
						url,
						bitableRecordId: item.bitableRecordId,
						direction: 'obsidian-to-feishu',
						remoteRevision: remoteMeta?.revision,
						remoteUpdatedAt: remoteMeta?.updatedAt
					});
					await this.saveSettings();

					if (syncTarget === 'both') {
						try {
							bitableRecordIdForFile = await this.syncFileToBitable(file, title, rawContent, processResult, statusNotice, silent);
						} catch (e) {
							completed = false;
							console.error('[feishu-share] Failed to sync Bitable after Feishu doc update', e);
							this.log(`Failed to sync Bitable after Feishu doc update: ${(e as Error)?.message || String(e)}`, 'warn');
							await this.recordSyncError(file, 'bitable', e, '同步到多维表格', {
								docToken: this.extractDocTokenFromUrl(result.url || '') || undefined,
								url: result.url,
								remoteRevision: remoteMeta?.revision,
								remoteUpdatedAt: remoteMeta?.updatedAt,
								docRemoteRevision: remoteMeta?.revision,
								docRemoteUpdatedAt: remoteMeta?.updatedAt
							});
						}
					}
				} catch (e) {
					completed = false;
					console.error('[feishu-share] Failed to update upload history / bitable sync', e);
					this.log(`Failed to update upload history / bitable sync: ${(e as Error)?.message || String(e)}`, 'warn');
					await this.recordSyncError(file, 'bitable', e, '同步到多维表格或更新映射', {
						docToken: this.extractDocTokenFromUrl(result.url || '') || undefined,
						url: result.url,
						remoteRevision: remoteMeta?.revision,
						remoteUpdatedAt: remoteMeta?.updatedAt,
						docRemoteRevision: remoteMeta?.revision,
						docRemoteUpdatedAt: remoteMeta?.updatedAt
					});
				}

				if (isUpdateMode.shouldUpdate && !urlChanged && !isForcedUpdate) {
					this.log(`Document updated successfully: ${result.title}`);

					// 更新模式：只更新feishu_shared_at时间戳
					if (this.settings.enableShareMarkInFrontMatter) {
						try {
							this.log('Updating share timestamp in front matter');
							const currentContent = await this.app.vault.read(file);
							const updatedContent = this.updateShareTimestamp(currentContent);
							await this.app.vault.modify(file, updatedContent);
							if (completed) {
								this.syncState.upsert({
									filePath: file.path,
									title,
									content: updatedContent,
									docToken: this.extractDocTokenFromUrl(result.url || '') || undefined,
									url: result.url,
									bitableRecordId: bitableRecordIdForFile,
									direction: 'obsidian-to-feishu',
									remoteRevision: remoteMeta?.revision,
									remoteUpdatedAt: remoteMeta?.updatedAt
								});
								await this.saveSettings();
							}
							this.log('Share timestamp updated successfully');
						} catch (error) {
							this.log(`Failed to update share timestamp: ${error.message}`, 'warn');
						}
					}
				} else {
					// 新分享模式或URL发生变化的情况
					if (urlChanged) {
						this.log(`Document URL changed, updating front matter: ${result.title}`);
					} else {
						this.log(`File shared successfully: ${result.title}`);
					}

					// 添加完整的分享标记（新分享或URL变化）
					if (this.settings.enableShareMarkInFrontMatter && result.url) {
						try {
							this.log('Adding/updating share mark in front matter');
							const currentContent = await this.app.vault.read(file);
							const updatedContent = this.markdownProcessor.addShareMarkToFrontMatter(currentContent, result.url, (file.stat as any)?.ctime, file.basename);
							await this.app.vault.modify(file, updatedContent);
							if (completed) {
								this.syncState.upsert({
									filePath: file.path,
									title,
									content: updatedContent,
									docToken: this.extractDocTokenFromUrl(result.url || '') || undefined,
									url: result.url,
									bitableRecordId: bitableRecordIdForFile,
									direction: 'obsidian-to-feishu',
									remoteRevision: remoteMeta?.revision,
									remoteUpdatedAt: remoteMeta?.updatedAt
								});
								await this.saveSettings();
							}
							this.log('Share mark added/updated successfully');

							// 如果URL发生了变化，显示特殊通知
							if (!this.settings.suppressShareNotices) {
								if (urlChanged && isUpdateMode.shouldUpdate) {
									new Notice(`📄 文档链接已更新（原链接不可访问）\n新链接：${result.url}`, 8000);
								}
							}
						} catch (error) {
							this.log(`Failed to add/update share mark: ${error.message}`, 'warn');
							// 不影响主要的分享成功流程，只记录警告
						}
					}
				}

				if (completed && bitableRecordIdForFile) {
					try {
						const updatedContent = await this.writeRecordIdToFileFrontMatter(file, bitableRecordIdForFile);
						if (updatedContent) {
							this.syncState.upsert({
								filePath: file.path,
								title,
								content: updatedContent,
								docToken: this.extractDocTokenFromUrl(result.url || '') || undefined,
								url: result.url,
								bitableRecordId: bitableRecordIdForFile,
								direction: 'obsidian-to-feishu',
								remoteRevision: remoteMeta?.revision,
								remoteUpdatedAt: remoteMeta?.updatedAt
							});
							await this.saveSettings();
						}
					} catch (error) {
						this.log(`Failed to write recordId to front matter: ${error.message}`, 'warn');
					}
				}

				if (completed) {
					if (!silent) {
						this.showSuccessNotification(result);
					}
				} else if (!silent && !this.settings.suppressShareNotices) {
					new Notice('⚠️ 飞书文档已更新，但后续映射或多维表格同步失败，请查看同步状态后重试');
				}
				return completed;
			} else {
				const operation = isUpdateMode.shouldUpdate ? '更新' : '分享';
				this.log(`${operation} failed: ${result.error}`, 'error');
				await this.recordSyncError(file, 'obsidian-to-feishu', new Error(result.error || `${operation}失败`), `飞书${operation}`, {
					docToken: this.extractDocTokenFromUrl(result.url || '') || undefined,
					url: result.url
				});
				if (!silent) {
					new Notice(`❌ ${operation}失败：${result.error}`);
				}
				return false;
			}

		} catch (error) {
			// 确保隐藏状态提示
			statusNotice?.hide();
			await this.recordSyncError(file, 'obsidian-to-feishu', error, '文件分享');
			if (!silent) {
				this.handleError(error as Error, '文件分享');
			} else {
				this.log(`Share failed for ${file.path}: ${this.getErrorMessage(error)}`, 'warn');
			}
			return false;
		}
	}

	private async pullFileFromBitable(file: TFile, options?: SyncExecutionOptions): Promise<boolean> {
		const interactive = options?.interactive !== false;
		const silent = options?.silent === true;
		const forceRemoteOverwrite = options?.forceRemoteOverwrite === true;
		const statusNotice = (silent || this.settings.suppressShareNotices) ? undefined : new Notice('📊 正在从多维表格拉取...', 0);
		try {
			const profileContent = await this.app.vault.read(file);
			const profile = this.getBitableProfileForFile(file, profileContent);
			if (profile) {
				statusNotice?.hide();
				return await this.pullFileFromBitableProfile(file, profile, options);
			}
			if (!this.settings.bitableAppToken || !this.settings.bitableTableId) {
				throw new Error('请先在设置中填写 Bitable App Token 和 Bitable Table ID');
			}
			const history = Array.isArray(this.settings.uploadHistory) ? this.settings.uploadHistory : [];
			const idx = history.findIndex((h) => h && h.filePath === file.path);
			const existing = idx >= 0 ? history[idx] : null;
			const state = this.syncState.getState(file.path);
			const current = await this.app.vault.read(file);
			const recordId = this.getBitableRecordIdForFile(file, current);
			if (!recordId) {
				throw new Error('当前文件没有关联的 Bitable recordId');
			}

			const record = await this.feishuApi.getBitableRecord(this.settings.bitableAppToken, this.settings.bitableTableId, recordId);
			if (!record.success || !record.fields) {
				throw new Error(record.error || '读取 Bitable 记录失败');
			}
			const fields = record.fields;
			const remoteHash = this.hashBitableFields(fields);
			const fieldMapping = this.getBitableFieldMapping();
			const contentValue = this.bitableFieldToPlainText(this.getBitableFieldValue(fields, 'content', fieldMapping));
			const nextBody = contentValue || current.replace(/^---\s*\n[\s\S]*?\n---\s*(\n|$)/, '');
			let nextContent = this.applyBitableFieldsToFrontMatter(current, fields, record.recordId || recordId, fieldMapping);
			if (contentValue) {
				if (nextContent.startsWith('---\n') || nextContent.startsWith('---\r\n')) {
					nextContent = nextContent.replace(/^(---\s*\n[\s\S]*?\n---\s*)(\n|$)[\s\S]*$/, (_m, fm) => `${fm}\n${nextBody}`);
				} else {
					nextContent = nextBody;
				}
			}

			const localChange = this.syncState.getLocalChange(file.path, current);
			if (localChange.hasLocalChanges && nextContent !== current) {
				if (forceRemoteOverwrite) {
					statusNotice?.setMessage('💾 正在写入本地文件...');
				} else if (!interactive) {
					this.syncState.upsert({
						filePath: file.path,
						title: file.basename,
						content: current,
						docToken: existing && existing.docToken ? existing.docToken : state?.docToken,
						url: existing && existing.url ? existing.url : state?.url,
						bitableRecordId: record.recordId || recordId,
						direction: 'bitable',
						status: 'conflict',
						error: '定时同步检测到本地存在未同步改动，已跳过多维表格覆盖',
						remoteHash,
						remoteUpdatedAt: record.updatedAt
					});
					await this.saveSettings();
					this.log(`Scheduled sync skipped Bitable overwrite for ${file.path}`, 'warn');
					return false;
				}
				statusNotice?.hide();
				const shouldOverwrite = await this.confirmOverwriteLocalChanges(file.basename, localChange.lastHash || '', localChange.currentHash, '多维表格');
				if (!shouldOverwrite) {
					this.syncState.upsert({
						filePath: file.path,
						title: file.basename,
						content: current,
						docToken: existing && existing.docToken ? existing.docToken : state?.docToken,
						url: existing && existing.url ? existing.url : state?.url,
						bitableRecordId: record.recordId || recordId,
						direction: 'bitable',
						status: 'conflict',
						error: '用户取消从多维表格覆盖本地改动',
						remoteHash,
						remoteUpdatedAt: record.updatedAt
					});
					await this.saveSettings();
					if (!silent) {
						new Notice('已取消：本地内容有未同步改动');
					}
					return false;
				}
				statusNotice?.setMessage('💾 正在写入本地文件...');
			}

			const backupPath = nextContent !== current
				? await this.backupBeforeRemoteOverwrite(file, current, 'Bitable')
				: null;
			await this.app.vault.modify(file, nextContent);

			const now = Date.now();
			const item = {
				filePath: file.path,
				title: this.bitableFieldToPlainText(this.getBitableFieldValue(fields, 'title', fieldMapping)) || file.basename,
				docToken: existing && existing.docToken ? existing.docToken : state?.docToken,
				url: existing && existing.url ? existing.url : (state?.url || this.bitableFieldToPlainText(this.getBitableFieldValue(fields, 'link', fieldMapping))),
				bitableRecordId: record.recordId || recordId,
				updatedAt: now
			};
			if (idx >= 0) {
				history[idx] = { ...history[idx], ...item };
			} else {
				history.unshift(item);
			}
			this.settings.uploadHistory = history;
			this.syncState.upsert({
				filePath: file.path,
				title: item.title,
				content: nextContent,
				docToken: item.docToken,
				url: item.url,
				bitableRecordId: item.bitableRecordId,
				direction: 'bitable',
				remoteHash,
				remoteUpdatedAt: record.updatedAt
			});
			await this.saveSettings();
			statusNotice?.hide();
			if (!silent) {
				new Notice(backupPath ? `✅ 已从多维表格更新本地文件\n备份：${backupPath}` : '✅ 已从多维表格更新本地文件');
			}
			return true;
		} catch (e) {
			statusNotice?.hide();
			await this.recordSyncError(file, 'bitable', e, '从多维表格更新');
			if (!silent) {
				this.handleError(e as Error, '从多维表格更新');
			} else {
				this.log(`Pull from Bitable failed for ${file.path}: ${this.getErrorMessage(e)}`, 'warn');
			}
			return false;
		}
	}

	private async pullFileFromBitableProfile(file: TFile, profile: BitableSyncProfile, options?: SyncExecutionOptions): Promise<boolean> {
		const interactive = options?.interactive !== false;
		const silent = options?.silent === true;
		const forceRemoteOverwrite = options?.forceRemoteOverwrite === true;
		const statusNotice = (silent || this.settings.suppressShareNotices) ? undefined : new Notice(`📊 正在从 ${profile.name} 拉取...`, 0);
		try {
			const current = await this.app.vault.read(file);
			const recordId = this.getProfileRecordIdForFile(file, current, profile);
			if (!recordId) {
				throw new Error(`当前文件没有关联的 ${profile.name} recordId`);
			}
			const record = await this.feishuApi.getBitableRecord(profile.appToken, profile.tableId, recordId);
			if (!record.success || !record.fields) {
				if (this.isBitableRecordMissingError(record.error)) {
					await this.markProfileRemoteMissing(file, profile, recordId);
					statusNotice?.hide();
					if (!silent) {
						new Notice(`⚠️ ${profile.name} 远端记录已删除，本地文件已保留`);
					}
					return false;
				}
				throw new Error(record.error || `读取 ${profile.name} 记录失败`);
			}
			const finalRecordId = record.recordId || recordId;
			const remoteHash = this.hashBitableProfileRemote(profile, finalRecordId, record.fields);
			const fieldMetaByName = await this.getBitableProfileFieldMeta(profile);
			const nextContent = applyProfileRecordToMarkdown(current, profile, finalRecordId, record.fields, Date.now(), fieldMetaByName);
			const currentManaged = buildProfileManagedContent(current, profile);
			const nextManaged = buildProfileManagedContent(nextContent, profile);
			const localChange = this.syncState.getLocalChange(file.path, currentManaged);
			if (localChange.hasLocalChanges && nextManaged !== currentManaged) {
				if (forceRemoteOverwrite) {
					statusNotice?.setMessage('📝 正在写入本地文件...');
				} else if (!interactive) {
					await this.upsertProfileHistoryAndState({
						file,
						profile,
						recordId: finalRecordId,
						title: file.basename,
						content: currentManaged,
						remoteHash,
						remoteUpdatedAt: record.updatedAt,
						status: 'conflict',
						error: `定时同步检测到 ${profile.name} 本地受管内容存在未同步改动，已跳过远端覆盖`
					});
					this.log(`Scheduled sync skipped ${profile.name} overwrite for ${file.path}`, 'warn');
					return false;
				}
				statusNotice?.hide();
				const shouldOverwrite = await this.confirmOverwriteLocalChanges(file.basename, localChange.lastHash || '', localChange.currentHash, profile.name);
				if (!shouldOverwrite) {
					await this.upsertProfileHistoryAndState({
						file,
						profile,
						recordId: finalRecordId,
						title: file.basename,
						content: currentManaged,
						remoteHash,
						remoteUpdatedAt: record.updatedAt,
						status: 'conflict',
						error: `用户取消从 ${profile.name} 覆盖本地受管内容`
					});
					return false;
				}
				statusNotice?.setMessage('📝 正在写入本地文件...');
			}
			const backupPath = nextContent !== current
				? await this.backupBeforeRemoteOverwrite(file, current, profile.name)
				: null;
			if (nextContent !== current) {
				await this.app.vault.modify(file, nextContent);
			}
			const targetFile = await this.ensureProfileFilePath(file, profile, finalRecordId, record.fields);
			await this.upsertProfileHistoryAndState({
				file: targetFile,
				profile,
				recordId: finalRecordId,
				title: targetFile.basename,
				content: nextManaged,
				remoteHash,
				remoteUpdatedAt: record.updatedAt
			});
			statusNotice?.hide();
			if (!silent) {
				new Notice(backupPath ? `✅ 已从 ${profile.name} 更新本地文件\n备份：${backupPath}` : `✅ 已从 ${profile.name} 更新本地文件`);
			}
			return true;
		} catch (error) {
			statusNotice?.hide();
			if (!silent) {
				this.handleError(error as Error, `从 ${profile.name} 更新`);
			} else {
				this.log(`Pull from ${profile.name} failed for ${file.path}: ${this.getErrorMessage(error)}`, 'warn');
			}
			return false;
		}
	}

	private bitableFieldToPlainText(value: any): string {
		return bitableFieldToPlainText(value);
	}

	private applyBitableFieldsToFrontMatter(content: string, fields: Record<string, any>, recordId: string, mapping?: Record<string, string>): string {
		let next = content;
		const simpleFields = ['title', 'status', 'link', 'created', 'updated', 'excerpt', 'author', 'slug', 'folder'];
		for (const key of simpleFields) {
			const value = bitableFieldToFrontMatterValue(this.getBitableFieldValue(fields, key, mapping));
			if (value !== undefined) {
				next = this.setFrontMatterField(next, key, this.formatFrontMatterValue(value));
			}
		}
		for (const key of ['tags', 'aliases']) {
			const value = bitableFieldToFrontMatterValue(this.getBitableFieldValue(fields, key, mapping), 4);
			if (Array.isArray(value) && value.length > 0) {
				next = this.setFrontMatterField(next, key, JSON.stringify(value));
			}
		}
		if (recordId) {
			next = this.setFrontMatterField(next, 'recordId', recordId);
		}
		return next;
	}

	private formatFrontMatterValue(value: string | number | boolean | string[]): string {
		if (Array.isArray(value)) {
			return JSON.stringify(value);
		}
		if (typeof value === 'number' || typeof value === 'boolean') {
			return String(value);
		}
		if (/^(true|false|null|\d+(\.\d+)?)$/i.test(value)) {
			return value;
		}
		return JSON.stringify(value);
	}

	private getBitableFieldMapping(): Record<string, string> {
		const raw = String(this.settings.bitableFieldMapping || '').trim();
		if (!raw) {
			return {};
		}
		try {
			const parsed = JSON.parse(raw);
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
				throw new Error('字段映射必须是 JSON 对象');
			}
			const mapping: Record<string, string> = {};
			for (const [key, value] of Object.entries(parsed)) {
				const logicalKey = String(key || '').trim();
				const fieldName = String(value || '').trim();
				if (logicalKey && fieldName) {
					mapping[logicalKey] = fieldName;
				}
			}
			return mapping;
		} catch (error) {
			this.log(`Bitable field mapping parse failed: ${(error as Error).message}`, 'warn');
			return {};
		}
	}

	private getBitableFieldName(logicalKey: string, mapping?: Record<string, string>): string {
		const map = mapping || this.getBitableFieldMapping();
		return map[logicalKey] || logicalKey;
	}

	private getBitableFieldValue(fields: Record<string, any>, logicalKey: string, mapping?: Record<string, string>): any {
		const fieldName = this.getBitableFieldName(logicalKey, mapping);
		return fields ? fields[fieldName] : undefined;
	}

	private mapBitableFieldsForWrite(fields: Record<string, any>, mapping: Record<string, string>): Record<string, any> {
		const mapped: Record<string, any> = {};
		for (const [logicalKey, value] of Object.entries(fields)) {
			mapped[this.getBitableFieldName(logicalKey, mapping)] = value;
		}
		return mapped;
	}

	private async syncFileToBitable(file: TFile, title: string, rawContent: string, processResult: any, statusNotice?: Notice, silent: boolean = false): Promise<string | undefined> {
		const profile = this.getBitableProfileForFile(file, rawContent);
		if (profile) {
			return await this.syncFileToBitableProfile(file, title, rawContent, profile, statusNotice, silent);
		}
		try {
			if (!this.settings.bitableAppToken || !this.settings.bitableTableId) {
				throw new Error('请先在设置中填写 Bitable App Token 和 Bitable Table ID');
			}
			const now = Date.now();
			const history = Array.isArray(this.settings.uploadHistory) ? this.settings.uploadHistory : [];
			const idx = history.findIndex((h) => h && h.filePath === file.path);
			const existing = idx >= 0 ? history[idx] : null;
			const state = this.syncState.getState(file.path);
			const existingUrl = existing && existing.url ? String(existing.url) : (state?.url || '');
			const existingToken = existing && existing.docToken ? String(existing.docToken) : state?.docToken;
			const remoteMeta = existingToken ? await this.feishuApi.getDocumentMeta(existingToken) : null;

			statusNotice?.setMessage('📊 正在同步到多维表格...');
			const normalizeBitableId = (input: string) => String(input || '')
				.trim()
				.replace(/^[\s"'“”‘’`]+/, '')
				.replace(/[\s"'“”‘’`]+$/, '')
				.trim();
			const rawAppToken = this.settings.bitableAppToken;
			const rawTableId = this.settings.bitableTableId;
			const normalizedAppToken = normalizeBitableId(rawAppToken);
			const normalizedTableId = normalizeBitableId(rawTableId);
			const fieldsMeta = await this.feishuApi.getBitableTableFields(rawAppToken, rawTableId);
			const metaFields = (fieldsMeta.success && fieldsMeta.fields) ? fieldsMeta.fields : [];
			if (!fieldsMeta.success) {
				console.error('[feishu-share] Bitable fields meta fetch failed', {
					appToken: rawAppToken,
					tableId: rawTableId,
					normalizedAppToken,
					normalizedTableId,
					error: fieldsMeta.error
				});
				throw new Error(
					`获取多维表格字段失败：${fieldsMeta.error || '未知错误'}（请检查 AppToken 是否为多维表格 OpenAPI 的 app_token；TableId 通常以 tbl 开头；并确认应用已开通多维表格相关权限）`
				);
			}
			if (!metaFields || metaFields.length === 0) {
				console.error('[feishu-share] Bitable fields meta empty', {
					appToken: this.settings.bitableAppToken,
					tableId: this.settings.bitableTableId
				});
				throw new Error('未获取到多维表格字段元数据（items 为空），请检查 TableId 是否指向正确数据表、以及应用是否有该表权限');
			}
			const allowed = new Set(metaFields.map((f) => f.name));
			const fieldMetaByName = new Map(metaFields.map((f) => [f.name, f] as const));
			const fieldMapping = this.getBitableFieldMapping();
			const folder = file.parent ? file.parent.path : '';
			const slug = file.basename;
			const frontmatter = processResult && processResult.frontMatter ? processResult.frontMatter : null;
			const frontmatterStr = frontmatter ? JSON.stringify(frontmatter) : '';
			const contentStr = processResult && processResult.content ? String(processResult.content) : rawContent;
			const frontMatterRecordId = frontmatter && frontmatter.recordId ? String(frontmatter.recordId) : this.extractFrontMatterValue(rawContent, 'recordId');
			const recordId = existing && existing.bitableRecordId
				? String(existing.bitableRecordId)
				: (state && state.bitableRecordId ? String(state.bitableRecordId) : (frontMatterRecordId || undefined));
			const createdStr = (() => {
				const ctime = (file && file.stat) ? (file.stat as any).ctime : undefined;
				const c = (typeof ctime === 'number') ? ctime : now;
				const t = new Date(c);
				const china = new Date(t.getTime() + (8 * 60 * 60 * 1000));
				const yyyy = china.getUTCFullYear();
				const mm = String(china.getUTCMonth() + 1).padStart(2, '0');
				const dd = String(china.getUTCDate()).padStart(2, '0');
				const HH = String(china.getUTCHours()).padStart(2, '0');
				const MM = String(china.getUTCMinutes()).padStart(2, '0');
				return `${yyyy}-${mm}-${dd} ${HH}:${MM}`;
			})();
			const updatedStr = (() => {
				const t = new Date(now);
				const china = new Date(t.getTime() + (8 * 60 * 60 * 1000));
				const yyyy = china.getUTCFullYear();
				const mm = String(china.getUTCMonth() + 1).padStart(2, '0');
				const dd = String(china.getUTCDate()).padStart(2, '0');
				const HH = String(china.getUTCHours()).padStart(2, '0');
				const MM = String(china.getUTCMinutes()).padStart(2, '0');
				return `${yyyy}-${mm}-${dd} ${HH}:${MM}`;
			})();
			const normalizeStringArray = (v: any): string[] => {
				if (Array.isArray(v)) {
					return v.map((x) => String(x)).filter((x) => x.length > 0);
				}
				if (typeof v === 'string') {
					const s = v.trim();
					if (!s) return [];
					return s.split(/[,\n\r\t]+/).map((x) => x.trim()).filter((x) => x.length > 0);
				}
				return [];
			};
			const tagsArr = normalizeStringArray(frontmatter && (frontmatter.tags ?? frontmatter.tag));
			const aliasesArr = normalizeStringArray(frontmatter && frontmatter.aliases);
			const excerptStr = (frontmatter && typeof frontmatter.excerpt === 'string') ? frontmatter.excerpt : '';
			const authorStr = (frontmatter && typeof frontmatter.author === 'string') ? frontmatter.author : '';
			const candidateFields: Record<string, any> = {
				title,
				content: contentStr,
				frontmatter: frontmatterStr,
				status: 'published',
				link: existingUrl,
				created: createdStr,
				updated: updatedStr,
				tags: tagsArr,
				excerpt: excerptStr,
				author: authorStr,
				aliases: aliasesArr,
				slug,
				folder,
				value: file.path
			};
			const mappedCandidateFields = this.mapBitableFieldsForWrite(candidateFields, fieldMapping);
			const excluded = new Set(
				String(this.settings.bitableExcludedFields || '')
					.split(/[\n\r,]+/)
					.map((s) => s.trim())
					.filter((s) => s.length > 0)
			);
			const excludedTableFields = new Set<string>();
			for (const item of excluded) {
				excludedTableFields.add(item);
				excludedTableFields.add(this.getBitableFieldName(item, fieldMapping));
			}
			const afterExclude: Record<string, any> = excludedTableFields.size > 0
				? Object.fromEntries(Object.entries(mappedCandidateFields).filter(([k]) => !excludedTableFields.has(k)))
				: mappedCandidateFields;
			const picked: Record<string, any> = allowed.size > 0
				? Object.fromEntries(Object.entries(afterExclude).filter(([k]) => allowed.has(k)))
				: afterExclude;
			const fields: Record<string, any> = Object.fromEntries(
				Object.entries(picked).map(([k, v]) => [k, normalizeBitableWriteValue(v, fieldMetaByName.get(k), now)])
			);

			const upsert = await this.feishuApi.upsertBitableRecord({
				appToken: this.settings.bitableAppToken,
				tableId: this.settings.bitableTableId,
				recordId,
				fields
			});

			if (!upsert.success) {
				console.error('[feishu-share] Bitable upsert failed', {
					filePath: file.path,
					appToken: this.settings.bitableAppToken,
					tableId: this.settings.bitableTableId,
					recordId,
					upsertError: upsert.error,
					fieldsMetaCount: metaFields.length,
					sentFieldNames: Object.keys(fields),
					sentFieldTypes: Object.fromEntries(Object.keys(fields).map((k) => [k, typeof fields[k]])),
					metaFields: metaFields.map((f) => ({ name: f.name, type: f.type }))
				});
				throw new Error(upsert.error || '同步到多维表格失败');
			}

			const recordIdFieldName = this.getBitableFieldName('recordId', fieldMapping);
			if (upsert.recordId && allowed.has(recordIdFieldName)) {
				try {
					const ridValue = normalizeBitableWriteValue(upsert.recordId, fieldMetaByName.get(recordIdFieldName), now);
					await this.feishuApi.upsertBitableRecord({
						appToken: this.settings.bitableAppToken,
						tableId: this.settings.bitableTableId,
						recordId: upsert.recordId,
						fields: { [recordIdFieldName]: ridValue }
					});
				} catch (e) {
					console.warn('[feishu-share] Failed to write recordId field back to bitable', e);
				}
			}

			const item = {
				filePath: file.path,
				title,
				docToken: existingToken,
				url: existingUrl,
				bitableRecordId: upsert.recordId || recordId,
				updatedAt: now
			};
			const bitableMeta = item.bitableRecordId
				? await this.feishuApi.getBitableRecord(this.settings.bitableAppToken, this.settings.bitableTableId, item.bitableRecordId)
				: null;
			const bitableRemoteHash = bitableMeta?.fields ? this.hashBitableFields(bitableMeta.fields) : undefined;
			if (idx >= 0) {
				history[idx] = { ...history[idx], ...item };
			} else {
				history.unshift(item);
			}
			this.settings.uploadHistory = history;
			this.syncState.upsert({
				filePath: file.path,
				title,
				content: rawContent,
				docToken: existingToken,
				url: existingUrl,
				bitableRecordId: item.bitableRecordId,
				direction: 'bitable',
				remoteHash: bitableRemoteHash,
				remoteRevision: remoteMeta?.revision,
				remoteUpdatedAt: bitableMeta?.updatedAt || remoteMeta?.updatedAt,
				docRemoteRevision: remoteMeta?.revision,
				docRemoteUpdatedAt: remoteMeta?.updatedAt,
				bitableRemoteHash,
				bitableRemoteUpdatedAt: bitableMeta?.updatedAt
			});
			await this.saveSettings();

			if (upsert.recordId) {
				try {
					const updatedContent = await this.writeRecordIdToFileFrontMatter(file, upsert.recordId);
					if (updatedContent) {
						this.syncState.upsert({
							filePath: file.path,
							title,
							content: updatedContent,
							docToken: existingToken,
							url: existingUrl,
							bitableRecordId: upsert.recordId,
							direction: 'bitable',
							remoteHash: bitableRemoteHash,
							remoteRevision: remoteMeta?.revision,
							remoteUpdatedAt: bitableMeta?.updatedAt || remoteMeta?.updatedAt,
							docRemoteRevision: remoteMeta?.revision,
							docRemoteUpdatedAt: remoteMeta?.updatedAt,
							bitableRemoteHash,
							bitableRemoteUpdatedAt: bitableMeta?.updatedAt
						});
						await this.saveSettings();
					}
				} catch {
				}
			}

			if (!silent && !this.settings.suppressShareNotices) {
				new Notice('✅ 已同步到多维表格');
			}
			return upsert.recordId || recordId;
		} catch (e) {
			statusNotice?.hide();
			throw e;
		}
	}

	private async writeRecordIdToFileFrontMatter(file: TFile, recordId: string): Promise<string | null> {
		const rid = String(recordId || '').trim();
		if (!rid) return null;
		const current = await this.app.vault.read(file);
		const updated = this.setFrontMatterField(current, 'recordId', rid);
		if (updated !== current) {
			await this.app.vault.modify(file, updated);
			return updated;
		}
		return null;
	}

	private extractFrontMatterValue(content: string, key: string): string {
		const k = String(key || '').trim();
		if (!k) return '';
		const normalized = String(content || '').replace(/\r\n/g, '\n');
		if (!normalized.startsWith('---\n')) {
			return '';
		}
		const endIdx = normalized.indexOf('\n---\n', 4);
		if (endIdx < 0) {
			return '';
		}
		const keyRe = new RegExp(`^${this.escapeRegExp(k)}\\s*:\\s*(.*)$`);
		const lines = normalized.slice(4, endIdx).split('\n');
		for (const line of lines) {
			const match = line.trim().match(keyRe);
			if (!match) {
				continue;
			}
			return String(match[1] || '')
				.trim()
				.replace(/^["'“”‘’`]+/, '')
				.replace(/["'“”‘’`]+$/, '')
				.trim();
		}
		return '';
	}

	private setFrontMatterField(content: string, key: string, value: string): string {
		const k = String(key || '').trim();
		if (!k) return content;
		const v = String(value ?? '');
		const normalized = content.replace(/\r\n/g, '\n');
		if (!normalized.startsWith('---\n')) {
			const rebuilt = `---\n${k}: ${v}\n---\n${normalized}`;
			return content.includes('\r\n') ? rebuilt.replace(/\n/g, '\r\n') : rebuilt;
		}
		const endIdx = normalized.indexOf('\n---\n', 4);
		if (endIdx < 0) {
			return content;
		}
		const fm = normalized.slice(4, endIdx);
		const lines = fm.split('\n');
		let found = false;
		const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const keyRe = new RegExp(`^${escapeRegExp(k)}\\s*:`);
		const nextLines = lines.map((line) => {
			if (!found && keyRe.test(line)) {
				found = true;
				return `${k}: ${v}`;
			}
			return line;
		});
		if (!found) {
			nextLines.unshift(`${k}: ${v}`);
		}
		const newFm = nextLines.join('\n');
		const rebuilt = `---\n${newFm}\n---\n${normalized.slice(endIdx + 5)}`;
		return content.includes('\r\n') ? rebuilt.replace(/\n/g, '\r\n') : rebuilt;
	}

	private extractDocTokenFromUrl(url: string): string | null {
		try {
			if (!url) return null;
			const m = url.match(/\/docx\/([a-zA-Z0-9_\-]+)/);
			return m && m[1] ? m[1] : null;
		} catch {
			return null;
		}
	}



	/**
	 * 确保文件已保存到磁盘
	 * @param file 要检查的文件
	 */
	private async ensureFileSaved(file: TFile): Promise<void> {
		try {
			// 检查文件是否有未保存的修改
			const currentMtime = file.stat.mtime;

			Debug.verbose(`File mtime: ${currentMtime}`);

			// 如果文件最近被修改，等待一小段时间确保保存完成
			const now = Date.now();
			const timeSinceModification = now - currentMtime;

			if (timeSinceModification < 1000) { // 如果1秒内有修改
				Debug.verbose(`File was recently modified (${timeSinceModification}ms ago), waiting for save...`);

				// 等待文件保存
				await new Promise(resolve => setTimeout(resolve, 500));

				// 强制刷新文件缓存
				await this.app.vault.adapter.stat(file.path);

				Debug.verbose(`File save wait completed`);
			}

			// 额外的安全检查：如果当前文件正在编辑，尝试触发保存
			const activeFile = this.app.workspace.getActiveFile();
			if (activeFile && activeFile.path === file.path) {
				Debug.verbose(`File is currently active, ensuring it's saved`);

				// 使用workspace的方式触发保存
				const activeLeaf = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (activeLeaf && activeLeaf.file?.path === file.path) {
					// 触发编辑器保存
					await activeLeaf.save();
				}

				// 再等待一小段时间
				await new Promise(resolve => setTimeout(resolve, 200));
			}

		} catch (error) {
			Debug.warn('Error ensuring file is saved:', error);
			// 不抛出错误，继续执行
		}
	}

	/**
	 * 检查是否为更新模式
	 * @param frontMatter Front Matter数据
	 * @returns 更新模式检查结果
	 */
	private checkUpdateMode(frontMatter: Record<string, unknown> | null): {shouldUpdate: boolean, feishuUrl?: string} {
		if (!frontMatter) {
			return { shouldUpdate: false };
		}

		// 兼容旧字段（feishushare/feishu_url）与新字段（status/link）
		const hasFeishuShare = frontMatter.feishushare === true || frontMatter.feishushare === 'true' || frontMatter.status === 'published';
		const feishuUrl = (frontMatter.link && typeof frontMatter.link === 'string')
			? frontMatter.link
			: frontMatter.feishu_url;

		if (hasFeishuShare && feishuUrl && typeof feishuUrl === 'string') {
			this.log(`Found feishushare marker with URL: ${feishuUrl}`);
			return {
				shouldUpdate: true,
				feishuUrl: feishuUrl
			};
		}

		return { shouldUpdate: false };
	}

	/**
	 * 更新分享时间戳
	 * 基于文本操作，保留原始YAML结构
	 * @param content 原始文件内容
	 * @returns 更新后的文件内容
	 */
	private updateShareTimestamp(content: string): string {
		// 获取东8区时间
		const now = new Date();
		const chinaTime = new Date(now.getTime() + (8 * 60 * 60 * 1000)); // UTC+8
		const yyyy = chinaTime.getUTCFullYear();
		const mm = String(chinaTime.getUTCMonth() + 1).padStart(2, '0');
		const dd = String(chinaTime.getUTCDate()).padStart(2, '0');
		const HH = String(chinaTime.getUTCHours()).padStart(2, '0');
		const MM = String(chinaTime.getUTCMinutes()).padStart(2, '0');
		const currentTime = `${yyyy}-${mm}-${dd} ${HH}:${MM}`;

		// 检查是否有Front Matter
		if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) {
			return content; // 没有Front Matter，直接返回
		}

		const lines = content.split('\n');
		let endIndex = -1;

		// 找到Front Matter的结束位置
		for (let i = 1; i < lines.length; i++) {
			if (lines[i].trim() === '---') {
				endIndex = i;
				break;
			}
		}

		if (endIndex === -1) {
			return content; // 没有找到结束标记
		}

		// 优先更新 updated；同时兼容更新旧字段 feishu_shared_at
		let updatedDone = false;
		let legacyDone = false;
		for (let i = 1; i < endIndex; i++) {
			const trimmedLine = lines[i].trim();
			if (!updatedDone && trimmedLine.startsWith('updated:')) {
				lines[i] = `updated: "${currentTime}"`;
				updatedDone = true;
			}
			if (!legacyDone && trimmedLine.startsWith('feishu_shared_at:')) {
				lines[i] = `feishu_shared_at: "${currentTime}"`;
				legacyDone = true;
			}
			if (updatedDone && legacyDone) {
				break;
			}
		}

		return lines.join('\n');
	}

	/**
	 * 检查并刷新token
	 */
	async ensureValidAuth(): Promise<boolean> {
		if (!this.settings.accessToken) {
			return false;
		}

		// 这里可以添加token有效性检查和自动刷新逻辑
		// 暂时简单返回true
		return true;
	}

	/**
	 * 显示分享成功的通知
	 */
	private showSuccessNotification(result: ShareResult): void {
		if (this.settings.simpleSuccessNotice || !result.url) {
			const titleText = result?.title || '文档';
			const message = SUCCESS_NOTICE_TEMPLATE.replace('{title}', titleText);
			new Notice(message, 5000);
			return;
		}

		// 富通知：带复制与打开按钮
		const message = `✅ 分享成功！文档：${result.title}`;
		const notice = new Notice(message, 8000);

		const buttonContainer = notice.noticeEl.createEl('div', { cls: 'setting-item-control' });

		// 复制按钮
		const copyButton = buttonContainer.createEl('button', {
			text: '📋 复制链接',
			cls: 'mod-cta'
		});
		copyButton.addClass('mod-cta');
		copyButton.onclick = async () => {
			try {
				const urlToCopy = result.url as string;
				await navigator.clipboard.writeText(urlToCopy);
				this.log('URL copied to clipboard');
				copyButton.textContent = '✅ 已复制';
				setTimeout(() => {
					copyButton.textContent = '📋 复制链接';
				}, 2000);
			} catch (error) {
				this.log(`Failed to copy URL: ${(error as Error).message}`, 'error');
				new Notice('❌ 复制失败');
			}
		};

		// 打开按钮
		const openButton = buttonContainer.createEl('button', {
			text: '🔗 打开',
			cls: 'mod-muted'
		});
		openButton.addClass('mod-muted');
		openButton.onclick = () => {
			if (result.url) {
				window.open(result.url, '_blank');
			}
		};
	}

	/**
	 * 统一的错误处理方法
	 */
	private handleError(error: Error, context: string, userMessage?: string): void {
		Debug.error(`${context}:`, error);

		const message = userMessage || `❌ ${context}失败: ${error.message}`;
		new Notice(message);
	}

	/**
	 * 统一的日志记录方法
	 */
	private log(message: string, level: 'info' | 'warn' | 'error' = 'info'): void {
		switch (level) {
			case 'error':
				Debug.error(message);
				break;
			case 'warn':
				Debug.warn(message);
				break;
			default:
				Debug.log(message);
		}
	}
}
