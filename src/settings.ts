import { App, PluginSettingTab, Setting } from "obsidian";
import NestedTablesPlugin from "./main";

export interface NestedTableSettings {
	maxDepth: number;
	warnDepth: number;
	enableEditorWidget: boolean;
}

export const DEFAULT_SETTINGS: NestedTableSettings = {
	maxDepth: 10,
	warnDepth: 3,
	enableEditorWidget: true,
};

export class NestedTableSettingTab extends PluginSettingTab {
	plugin: NestedTablesPlugin;

	constructor(app: App, plugin: NestedTablesPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "嵌套表格设置" });

		new Setting(containerEl)
			.setName("最大渲染深度")
			.setDesc("嵌套表格的最大递归渲染层数（1-5）")
			.addSlider((slider) =>
				slider
					.setLimits(1, 5, 1)
					.setValue(this.plugin.settings.maxDepth)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.maxDepth = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("警告深度阈值")
			.setDesc("超过此深度时显示黄色警告提示（1-5）")
			.addSlider((slider) =>
				slider
					.setLimits(1, 5, 1)
					.setValue(this.plugin.settings.warnDepth)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.warnDepth = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("编辑模式可视化")
			.setDesc("在编辑模式下将 @table:xxx 显示为可点击图标")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableEditorWidget)
					.onChange(async (value) => {
						this.plugin.settings.enableEditorWidget = value;
						await this.plugin.saveSettings();
						this.plugin.refreshEditorExtensions();
					})
			);
	}
}
