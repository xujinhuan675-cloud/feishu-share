export type SmartSyncTargetStatus = {
	mapped: boolean;
	hasBaseline: boolean;
	hasLocalChanges: boolean;
	hasRemoteChanges: boolean;
};

export type SmartSyncBothPlanAction =
	| 'create-all'
	| 'push-all'
	| 'pull-feishu'
	| 'pull-bitable'
	| 'choose-local-vs-feishu'
	| 'choose-local-vs-bitable'
	| 'choose-remote-source'
	| 'noop';

export type SmartSyncBothPlan = {
	action: SmartSyncBothPlanAction;
	reason: string;
	convergeAfterPull: boolean;
};

export function planSmartSyncBoth(feishu: SmartSyncTargetStatus, bitable: SmartSyncTargetStatus): SmartSyncBothPlan {
	const hasAnyMapping = feishu.mapped || bitable.mapped;
	const hasLocalChanges = feishu.hasLocalChanges || bitable.hasLocalChanges;
	const hasBaseline = feishu.hasBaseline || bitable.hasBaseline;
	const feishuRemote = feishu.mapped && feishu.hasRemoteChanges;
	const bitableRemote = bitable.mapped && bitable.hasRemoteChanges;

	if (!hasAnyMapping) {
		return buildPlan('create-all', '未找到飞书文档或多维表格映射');
	}
	if (feishuRemote && bitableRemote) {
		return buildPlan('choose-remote-source', '飞书文档和多维表格都有远端改动', true);
	}
	if (hasLocalChanges && feishuRemote) {
		return buildPlan('choose-local-vs-feishu', '本地和飞书文档都有改动', true);
	}
	if (hasLocalChanges && bitableRemote) {
		return buildPlan('choose-local-vs-bitable', '本地和多维表格都有改动', true);
	}
	if (feishuRemote) {
		return buildPlan('pull-feishu', '飞书文档有远端改动', true);
	}
	if (bitableRemote) {
		return buildPlan('pull-bitable', '多维表格有远端改动', true);
	}
	if (hasLocalChanges || !hasBaseline || !feishu.mapped || !bitable.mapped) {
		return buildPlan('push-all', '本地有改动或缺少同步基线/映射');
	}
	return buildPlan('noop', '本地、飞书文档和多维表格都已是最新');
}

function buildPlan(action: SmartSyncBothPlanAction, reason: string, convergeAfterPull = false): SmartSyncBothPlan {
	return { action, reason, convergeAfterPull };
}
