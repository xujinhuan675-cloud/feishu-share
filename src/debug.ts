export class Debug {
	private static readonly storageKey = 'feishu-share-debug-enabled';
	private static enabled = Debug.readEnabled();

	private static readEnabled(): boolean {
		try {
			return typeof localStorage !== 'undefined' && localStorage.getItem(Debug.storageKey) === 'true';
		} catch {
			return false;
		}
	}

	private static writeEnabled(value: boolean): void {
		try {
			if (typeof localStorage !== 'undefined') {
				localStorage.setItem(Debug.storageKey, value ? 'true' : 'false');
			}
		} catch {
			// Ignore storage errors in restricted runtimes.
		}
	}

	static enable(): void {
		Debug.enabled = true;
		Debug.writeEnabled(true);
	}

	static disable(): void {
		Debug.enabled = false;
		Debug.writeEnabled(false);
	}

	static isEnabled(): boolean {
		return Debug.enabled;
	}

	static log(message?: any, ...optionalParams: any[]): void {
		if (Debug.enabled) {
			console.log('[feishu-share]', message, ...optionalParams);
		}
	}

	static verbose(message?: any, ...optionalParams: any[]): void {
		if (Debug.enabled) {
			console.debug('[feishu-share]', message, ...optionalParams);
		}
	}

	static step(message?: any, ...optionalParams: any[]): void {
		if (Debug.enabled) {
			console.log('[feishu-share:step]', message, ...optionalParams);
		}
	}

	static result(message?: any, ...optionalParams: any[]): void {
		if (Debug.enabled) {
			console.log('[feishu-share:result]', message, ...optionalParams);
		}
	}

	static warn(message?: any, ...optionalParams: any[]): void {
		if (Debug.enabled) {
			console.warn('[feishu-share]', message, ...optionalParams);
		}
	}

	static error(message?: any, ...optionalParams: any[]): void {
		console.error('[feishu-share]', message, ...optionalParams);
	}
}
