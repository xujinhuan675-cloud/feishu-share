interface HTMLElement {
	empty(): void;
	addClass(className: string): void;
	removeClass(className: string): void;
	setText(text: string): void;
	createEl(tag: string, options?: any): any;
	createDiv(options?: any): any;
	createSpan(options?: any): any;
}

declare module 'obsidian' {
	export class Plugin {
		app: any;
		addCommand(command: any): void;
		addSettingTab(tab: any): void;
		registerEvent(eventRef: any): void;
		registerObsidianProtocolHandler(action: string, handler: (params: Record<string, string>) => void): void;
		loadData(): Promise<any>;
		saveData(data: any): Promise<void>;
	}

	export class PluginSettingTab {
		app: any;
		plugin: any;
		containerEl: HTMLElement;
		constructor(app: any, plugin: any);
		display(): void;
	}

	export class Setting {
		nameEl: HTMLElement;
		descEl: HTMLElement;
		controlEl: HTMLElement;
		constructor(containerEl: HTMLElement);
		setName(name: string): this;
		setDesc(desc: string): this;
		addText(cb: (text: any) => void): this;
		addTextArea(cb: (text: any) => void): this;
		addToggle(cb: (toggle: any) => void): this;
		addDropdown(cb: (dropdown: any) => void): this;
		addButton(cb: (button: any) => void): this;
		then(cb: (setting: this) => void): this;
	}

	export class Notice {
		constructor(message: string, timeout?: number);
		noticeEl: any;
		setMessage(message: string): void;
		hide(): void;
	}

	export class TFile {
		path: string;
		extension: string;
		name: string;
		basename: string;
		stat: { mtime: number };
		parent?: { path: string };
	}

	export class Menu {
		addItem(cb: (item: any) => void): void;
	}

	export interface Editor {}
	export class MarkdownView {
		file?: TFile;
		save(): Promise<void>;
	}
	export class Modal {
		constructor(app: any);
		open(): void;
		close(): void;
		contentEl: HTMLElement;
	}

	export function requestUrl(options: any): Promise<any>;
	export function normalizePath(path: string): string;
	export class App {
		vault: any;
		workspace: any;
	}
}
