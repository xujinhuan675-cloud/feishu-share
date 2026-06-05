/**
 * 飞书API配置常量
 */

export const FEISHU_CONFIG = {
	// API 基础地址
	BASE_URL: 'https://open.feishu.cn/open-apis',
	
	// OAuth 相关地址
	AUTHORIZE_URL: 'https://open.feishu.cn/open-apis/authen/v1/authorize',
	TOKEN_URL: 'https://open.feishu.cn/open-apis/authen/v2/oauth/token',
	REFRESH_TOKEN_URL: 'https://open.feishu.cn/open-apis/authen/v2/oauth/token',
	
	// API 权限范围（包含offline_access以支持refresh_token）
	SCOPES: 'contact:user.base:readonly docx:document docx:document.block:convert drive:drive wiki:wiki bitable:app base:field:read offline_access',
	
	// 文件上传相关（使用素材上传API，导入后自动删除源文件）
	UPLOAD_URL: 'https://open.feishu.cn/open-apis/drive/v1/medias/upload_all',
	
	// 文档创建相关
	DOC_CREATE_URL: 'https://open.feishu.cn/open-apis/docx/v1/documents',
	
	// 文件夹相关
	FOLDER_LIST_URL: 'https://open.feishu.cn/open-apis/drive/v1/files',
	
	// 用户信息
	USER_INFO_URL: 'https://open.feishu.cn/open-apis/authen/v1/user_info',
};

export const DEFAULT_SETTINGS: Partial<FeishuSettings> = {
	appId: '',
	appSecret: '',
	callbackUrl: 'https://md2feishu.xinqi.life/oauth-callback',
	accessToken: '',
	refreshToken: '',
	userInfo: null,

	// 新增：目标类型默认设置（默认知识库）
	targetType: 'wiki',

	// 云空间设置
	defaultFolderId: '',
	defaultFolderName: '我的空间',

	// 知识库设置
	defaultWikiSpaceId: '',
	defaultWikiSpaceName: '',
	defaultWikiNodeToken: '',
	defaultWikiNodeName: '',

	titleSource: 'filename',
	frontMatterHandling: 'remove',
	// 新增：链接分享默认设置
	enableLinkShare: true,
	linkSharePermission: 'anyone_readable',
	// 新增：内容处理默认设置
	enableSubDocumentUpload: true,
	enableLocalImageUpload: true,
	enableLocalAttachmentUpload: true,
	// 新增：上传文件列表（留空表示不限制）
	uploadFileList: '',
	// 新增：代码块过滤（默认空列表）
	codeBlockFilterLanguages: [],
	// 新增：分享标记默认设置
	enableShareMarkInFrontMatter: true,
	// 新增：通知抑制默认设置（默认不抑制）
	suppressShareNotices: false,
	// 新增：简洁成功通知（默认关闭，使用带按钮的富通知）
	simpleSuccessNotice: false,
	enableOverwriteBackup: true,

	// 同步相关默认值
	syncTarget: 'docx',
	batchSyncScope: 'current_file',
	batchSyncCustomFolder: '',
	enableScheduledSync: false,
	scheduledSyncIntervalMinutes: 30,
	scheduledSyncScope: 'tracked_files',
	scheduledSyncCustomFolder: '',
	scheduledSyncRunOnStartup: false,
	scheduledSyncReport: {
		status: 'idle',
		failureStreak: 0
	},
	uploadHistory: [],
	syncStates: [],

	// 多维表格（bitable）同步配置
	bitableAppToken: '',
	bitableTableId: '',
	bitableTableOptionsCache: [],
	bitableFieldMapping: '',
	bitableFieldNamesCache: [],
	bitableExcludedFields: '',
	bitableProfiles: [{ ...DEFAULT_IOTO_TASK_PROFILE }],
	activeBitableProfileId: '',
	enableScheduledBitableProfiles: false,
	scheduledBitableProfileIds: [DEFAULT_IOTO_TASK_PROFILE.id],
};

export const FEISHU_ERROR_MESSAGES: Record<number, string> = {
	1061002: '参数错误，请检查文件格式和大小',
	1061005: '文件大小超出限制',
	1061006: '文件类型不支持',
	99991663: 'access_token 无效',
	99991664: 'access_token 已过期',
	99991665: 'refresh_token 无效',
	99991666: 'refresh_token 已过期',
};

/**
 * 成功通知模板（简单、易于修改）
 * 可用占位符：{title}
 */
export const SUCCESS_NOTICE_TEMPLATE = '✅ 分享成功：{title}';

/**
 * Obsidian Callout 类型到飞书样式的映射表
 */
export const CALLOUT_TYPE_MAPPING: Record<string, { emoji: string; color: string; title: string }> = {
	// 信息类
	'note': { emoji: '📝', color: 'blue', title: '笔记' },
	'info': { emoji: 'ℹ️', color: 'blue', title: '信息' },
	'tip': { emoji: '💡', color: 'green', title: '提示' },
	'hint': { emoji: '💡', color: 'green', title: '提示' },

	// 警告类
	'warning': { emoji: '⚠️', color: 'yellow', title: '警告' },
	'caution': { emoji: '⚠️', color: 'yellow', title: '注意' },
	'attention': { emoji: '⚠️', color: 'yellow', title: '注意' },

	// 错误类
	'error': { emoji: '❌', color: 'red', title: '错误' },
	'danger': { emoji: '⛔', color: 'red', title: '危险' },
	'failure': { emoji: '❌', color: 'red', title: '失败' },
	'fail': { emoji: '❌', color: 'red', title: '失败' },
	'missing': { emoji: '❓', color: 'red', title: '缺失' },

	// 成功类
	'success': { emoji: '✅', color: 'green', title: '成功' },
	'check': { emoji: '✅', color: 'green', title: '检查' },
	'done': { emoji: '✅', color: 'green', title: '完成' },

	// 问题类
	'question': { emoji: '❓', color: 'purple', title: '问题' },
	'help': { emoji: '❓', color: 'purple', title: '帮助' },
	'faq': { emoji: '❓', color: 'purple', title: '常见问题' },

	// 引用类
	'quote': { emoji: '💬', color: 'gray', title: '引用' },
	'cite': { emoji: '📖', color: 'gray', title: '引用' },

	// 抽象类
	'abstract': { emoji: '📄', color: 'cyan', title: '摘要' },
	'summary': { emoji: '📄', color: 'cyan', title: '总结' },
	'tldr': { emoji: '📄', color: 'cyan', title: 'TL;DR' },

	// 示例类
	'example': { emoji: '📋', color: 'purple', title: '示例' },

	// 任务类
	'todo': { emoji: '☑️', color: 'blue', title: '待办' },

	// 默认类型
	'default': { emoji: '📌', color: 'blue', title: '提示' }
};

import type { FeishuSettings } from './types';
import { DEFAULT_IOTO_TASK_PROFILE } from './bitable-profile';
