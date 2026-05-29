import {
	App,
	MarkdownPostProcessorContext,
	Modal,
	Notice,
	Plugin,
	TFile,
	Vault,
} from "obsidian";
import {
	DEFAULT_SETTINGS,
	NestedTableSettings,
	NestedTableSettingTab,
} from "./settings";

interface SubTableRef {
	row: number;
	col: number;
	sourcePath: string;
}

interface TableData {
	headers: string[];
	rows: string[][];
	subTables: SubTableRef[];
}

type NestedTableData = TableData;

const SUBTABLE_REGEX = /^@table:(.+)$/;

const MAX_NESTED_TABLE_COUNT = 50;

function escapeHtml(text: string): string {
	const div = document.createElement("div");
	div.appendChild(document.createTextNode(text));
	return div.innerHTML;
}

async function loadNestedTable(
	sourcePath: string,
	vault: Vault,
	currentPath: string,
	visited: Set<string>,
	app: App
): Promise<NestedTableData> {
	const headers: string[] = [];
	const rows: string[][] = [];
	const subTables: SubTableRef[] = [];

	try {
		const resolved = app.metadataCache.getFirstLinkpathDest(
			sourcePath,
			currentPath
		);
		if (!resolved) {
			return {
				headers: ["错误"],
				rows: [[`未找到文件: ${escapeHtml(sourcePath)}`]],
				subTables: [],
			};
		}

		const resolvedPath = resolved.path;
		if (visited.has(resolvedPath)) {
			return {
				headers: ["错误"],
				rows: [[`循环引用检测: ${escapeHtml(sourcePath)}`]],
				subTables: [],
			};
		}

		const file = vault.getAbstractFileByPath(resolvedPath);
		if (!(file instanceof TFile)) {
			return {
				headers: ["错误"],
				rows: [[`未找到文件: ${escapeHtml(sourcePath)}`]],
				subTables: [],
			};
		}

		const content = await vault.read(file);
		const tableMatch = content.match(
			/\|(.+)\|\s*\n\|[-| :]+\|\s*\n((?:\|.+\|\s*\n?)*)/
		);
		if (!tableMatch) {
			return {
				headers: ["提示"],
				rows: [[`${escapeHtml(sourcePath)} 中没有找到 Markdown 表格`]],
				subTables: [],
			};
		}

		const headerLine = tableMatch[1] as string;
		const dataLines = (tableMatch[2] as string).trim().split("\n");

		const rawHeaders = headerLine.split("|").map((h) => h.trim());
		const validHeaders = rawHeaders.filter((h) => h.length > 0);
		headers.push(...validHeaders);

		const columnCount = headers.length;
		if (columnCount === 0) {
			return {
				headers: ["错误"],
				rows: [["表格没有有效列"]],
				subTables: [],
			};
		}

		visited.add(resolvedPath);

		for (let i = 0; i < dataLines.length; i++) {
			const line = dataLines[i] as string;
			const cells = line
				.split("|")
				.map((c) => c.trim())
				.filter((_, idx, arr) => {
					if (idx === 0 || idx === arr.length - 1) return false;
					return true;
				});

			const row: string[] = [];
			for (let j = 0; j < columnCount; j++) {
				const cellValue = cells[j] || "";
				row.push(cellValue);

				const match = cellValue.match(SUBTABLE_REGEX);
				if (match) {
					const refName = match[1] as string;
					subTables.push({
						row: i,
						col: j,
						sourcePath: refName.trim(),
					});
				}
			}
			rows.push(row);
		}

		return { headers, rows, subTables };
	} catch (err) {
		const msg =
			err instanceof Error ? err.message : "未知错误";
		return {
			headers: ["错误"],
			rows: [[`读取文件失败: ${escapeHtml(sourcePath)} - ${escapeHtml(msg)}`]],
			subTables: [],
		};
	}
}

function renderNestedTable(
	data: NestedTableData,
	depth: number,
	sourcePath: string,
	settings: NestedTableSettings,
	plugin: NestedTablesPlugin,
	nestedCount: { count: number }
): HTMLElement {
	const container = document.createElement("div");
	container.className = `nested-table-container depth-${Math.min(depth, 4)}`;

	if (depth > settings.warnDepth) {
		const warning = container.createDiv({
			cls: "subtable-depth-warning",
		});
		warning.textContent = `⚠ 嵌套深度 ${depth}，超过警告阈值 ${settings.warnDepth}`;
	}

	if (depth >= settings.maxDepth) {
		const limitMsg = container.createDiv({
			cls: "subtable-depth-warning",
		});
		limitMsg.textContent = `已到达最大嵌套深度 (${settings.maxDepth})，停止继续嵌套`;
		return container;
	}

	if (nestedCount.count >= MAX_NESTED_TABLE_COUNT) {
		const limitDiv = container.createDiv({
			cls: "nested-table-limit-warning",
		});
		limitDiv.textContent = `嵌套表格数量超过限制 (${MAX_NESTED_TABLE_COUNT})，剩余表格已折叠`;
		const expandAll = limitDiv.createEl("button", { text: "展开全部" });
		expandAll.addEventListener("click", () => {
			limitDiv.remove();
		});
		return container;
	}

	const table = container.createEl("table");
	const thead = table.createEl("thead");
	const headerRow = thead.createEl("tr");
	for (const header of data.headers) {
		headerRow.createEl("th", { text: header });
	}

	const tbody = table.createEl("tbody");
	const needsCollapse = data.rows.length > settings.autoFoldThreshold;

	let visibleRows = data.rows;

	if (needsCollapse) {
		tbody.classList.add("table-collapsed");

		const expandBtn = container.createEl("button", {
			cls: "expand-button",
			text: `展开全部 (共 ${data.rows.length} 行)`,
		});
		expandBtn.addEventListener("click", () => {
			tbody.classList.remove("table-collapsed");
			expandBtn.remove();
		});
	}

	for (let i = 0; i < visibleRows.length; i++) {
		const row = visibleRows[i] as string[];
		const tr = tbody.createEl("tr");

		for (let j = 0; j < data.headers.length; j++) {
			const cellValue = row[j] || "";
			const subTableRef = data.subTables.find(
				(ref) => ref.row === i && ref.col === j
			);

			const td = tr.createEl("td");

			if (subTableRef) {
				td.addClass("has-subtable");
				td.dataset.nestedSource = subTableRef.sourcePath;
				td.dataset.nestedRow = String(i);
				td.dataset.nestedCol = String(j);

				const placeholder = td.createSpan({
					cls: "subtable-placeholder",
				});
				placeholder.textContent = `▶ 子表格: ${subTableRef.sourcePath}`;

				placeholder.addEventListener("click", async (e) => {
					e.stopPropagation();
					placeholder.textContent = "加载中...";
					try {
						const subData = await loadNestedTable(
							subTableRef.sourcePath,
							plugin.app.vault,
							sourcePath,
							new Set<string>(),
							plugin.app
						);
						nestedCount.count++;
						const subContainer = renderNestedTable(
							subData,
							depth + 1,
							sourcePath,
							settings,
							plugin,
							nestedCount
						);
						td.empty();
						td.appendChild(subContainer);
					} catch {
						placeholder.textContent = "加载失败";
					}
				});

				td.addEventListener("dblclick", () => {
					handleCellDoubleClick(subTableRef.sourcePath, plugin);
				});
			} else {
				td.textContent = cellValue;
			}
		}
	}

	return container;
}

function handleCellDoubleClick(sourcePath: string, plugin: NestedTablesPlugin) {
	new NestedTableEditModal(plugin.app, sourcePath, plugin).open();
}

class NestedTableEditModal extends Modal {
	private sourcePath: string;
	private plugin: NestedTablesPlugin;
	private hasUnsavedChanges = false;

	constructor(app: App, sourcePath: string, plugin: NestedTablesPlugin) {
		super(app);
		this.sourcePath = sourcePath;
		this.plugin = plugin;
		this.titleEl.textContent = `编辑表格: ${sourcePath}`;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("nested-table-edit-modal");

		const loadingEl = contentEl.createDiv({ text: "加载中..." });
		this.loadTableData()
			.then((result) => {
				loadingEl.remove();
				if (result) {
					this.buildEditUI(contentEl, result.headers, result.rows);
				}
			})
			.catch(() => {
				loadingEl.textContent = "加载失败";
			});
	}

	private async loadTableData(): Promise<{
		headers: string[];
		rows: string[][];
	} | null> {
		try {
			const resolved = this.app.metadataCache.getFirstLinkpathDest(
				this.sourcePath,
				this.plugin.getActiveFilePath()
			);
			if (!resolved) {
				new Notice(`未找到文件: ${this.sourcePath}`);
				return null;
			}

			const file = this.app.vault.getAbstractFileByPath(resolved.path);
			if (!(file instanceof TFile)) {
				new Notice(`未找到文件: ${this.sourcePath}`);
				return null;
			}

			const content = await this.app.vault.read(file);
			const tableMatch = content.match(
				/\|(.+)\|\s*\n\|[-| :]+\|\s*\n((?:\|.+\|\s*\n?)*)/
			);
			if (!tableMatch) {
				new Notice("文件中没有找到 Markdown 表格");
				return null;
			}

			const headerLine = tableMatch[1] as string;
			const dataLines = (tableMatch[2] as string).trim().split("\n");

			const rawHeaders = headerLine.split("|").map((h) => h.trim());
			const headers = rawHeaders.filter((h) => h.length > 0);

			const rows: string[][] = [];
			for (const line of dataLines) {
				const cells = line
					.split("|")
					.map((c) => c.trim())
					.filter((_, idx, arr) => idx !== 0 && idx !== arr.length - 1);
				rows.push(cells);
			}

			return { headers, rows };
		} catch (err) {
			const msg = err instanceof Error ? err.message : "未知错误";
			new Notice(`读取文件失败: ${msg}`);
			return null;
		}
	}

	private buildEditUI(
		container: HTMLElement,
		headers: string[],
		rows: string[][]
	) {
		const colCount = headers.length;
		let currentHeaders = [...headers];
		let currentRows = rows.map((r) => {
			const padded = [...r];
			while (padded.length < colCount) padded.push(" ");
			return padded;
		});

		const gridContainer = container.createDiv({ cls: "edit-grid" });
		const inputs: HTMLInputElement[][] = [];

		const renderGrid = () => {
			gridContainer.empty();
			inputs.length = 0;

			const totalCols = currentHeaders.length;
			gridContainer.style.gridTemplateColumns = `repeat(${totalCols}, 1fr)`;

			for (const header of currentHeaders) {
				const input = gridContainer.createEl("input");
				input.type = "text";
				input.value = header;
				input.style.fontWeight = "bold";
				input.addEventListener("input", () => {
					this.hasUnsavedChanges = true;
				});
			}

			for (let i = 0; i < currentRows.length; i++) {
				const rowInputs: HTMLInputElement[] = [];
				const row = currentRows[i] || [];
				for (let j = 0; j < totalCols; j++) {
					const input = gridContainer.createEl("input");
					input.type = "text";
					input.value = row[j] || " ";
					input.addEventListener("input", () => {
						this.hasUnsavedChanges = true;
					});
					rowInputs.push(input);
				}
				inputs.push(rowInputs);
			}
		};

		renderGrid();

		const toolbar = container.createDiv({ cls: "edit-toolbar" });

		const addRowBtn = toolbar.createEl("button", { text: "+ 行" });
		addRowBtn.addEventListener("click", () => {
			const newRow = new Array(currentHeaders.length).fill(" ");
			currentRows.push(newRow);
			renderGrid();
			this.hasUnsavedChanges = true;
		});

		const addColBtn = toolbar.createEl("button", { text: "+ 列" });
		addColBtn.addEventListener("click", () => {
			currentHeaders.push("新列");
			for (const row of currentRows) {
				row.push(" ");
			}
			renderGrid();
			this.hasUnsavedChanges = true;
		});

		const removeRowBtn = toolbar.createEl("button", { text: "- 行" });
		removeRowBtn.addEventListener("click", () => {
			if (currentRows.length <= 2) {
				new Notice("至少保留2行");
				return;
			}
			currentRows.pop();
			renderGrid();
			this.hasUnsavedChanges = true;
		});

		const removeColBtn = toolbar.createEl("button", { text: "- 列" });
		removeColBtn.addEventListener("click", () => {
			if (currentHeaders.length <= 1) {
				new Notice("至少保留1列");
				return;
			}
			const lastIdx = currentHeaders.length - 1;
			currentHeaders.splice(lastIdx, 1);
			for (const row of currentRows) {
				row.splice(lastIdx, 1);
			}
			renderGrid();
			this.hasUnsavedChanges = true;
		});

		const actions = container.createDiv({ cls: "edit-actions" });

		const cancelBtn = actions.createEl("button", { text: "取消" });
		cancelBtn.addEventListener("click", () => {
			if (this.hasUnsavedChanges) {
				new Notice("有未保存的修改");
			}
			this.close();
		});

		const saveBtn = actions.createEl("button", { text: "保存并关闭" });
		saveBtn.addEventListener("click", async () => {
			const resolvedHeaders: string[] = [];
			const allInputs = gridContainer.querySelectorAll("input");
			const headerCount = currentHeaders.length;

			allInputs.forEach((input, idx) => {
				if (idx < headerCount) {
					resolvedHeaders.push(input.value || " ");
				}
			});

			const resolvedRows: string[][] = [];
			let rowIdx = 0;
			for (let idx = headerCount; idx < allInputs.length; idx += headerCount) {
				const row: string[] = [];
				for (let j = 0; j < headerCount; j++) {
					const cellInput = allInputs[idx + j] as HTMLInputElement;
					row.push(cellInput ? cellInput.value || " " : " ");
				}
				resolvedRows.push(row);
				rowIdx++;
			}

			await this.saveToFile(resolvedHeaders, resolvedRows);
		});
	}

	private async saveToFile(headers: string[], rows: string[][]) {
		try {
			const resolved = this.app.metadataCache.getFirstLinkpathDest(
				this.sourcePath,
				this.plugin.getActiveFilePath()
			);
			if (!resolved) {
				new Notice(`未找到文件: ${this.sourcePath}`);
				return;
			}

			const file = this.app.vault.getAbstractFileByPath(resolved.path);
			if (!(file instanceof TFile)) {
				new Notice(`未找到文件: ${this.sourcePath}`);
				return;
			}

			const sepLine = "|" + headers.map(() => "---").join("|") + "|";
			const dataLines = rows.map(
				(row) =>
					"|" +
					row.map((cell) => cell || " ").join("|") +
					"|"
			);

			const tableStr = [sepLine, ...dataLines].join("\n");

			let content = await this.app.vault.read(file);
			const tableMatch = content.match(
				/\|(.+)\|\s*\n\|[-| :]+\|\s*\n((?:\|.+\|\s*\n?)*)/
			);
			if (tableMatch) {
				const fullMatch = tableMatch[0] as string;
				const headerLine = "|" + headers.join("|") + "|";
				const newTable = [headerLine, ...tableStr.split("\n").slice(1)].join("\n");
				content = content.replace(fullMatch, newTable);
			} else {
				new Notice("文件中没有找到 Markdown 表格");
				return;
			}

			await this.app.vault.modify(file, content);
			new Notice("保存成功");
			this.hasUnsavedChanges = false;
			this.close();
		} catch (err) {
			const msg = err instanceof Error ? err.message : "未知错误";
			new Notice(`保存失败: ${msg}`);
		}
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

export default class NestedTablesPlugin extends Plugin {
	settings!: NestedTableSettings;

	async onload() {
		await this.loadSettings();

		this.addSettingTab(new NestedTableSettingTab(this.app, this));

		this.registerMarkdownPostProcessor(
			(el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
				const tables = el.querySelectorAll("table");
				if (tables.length === 0) return;

				const sourcePath = ctx.sourcePath;
				const nestedCount = { count: 0 };

				tables.forEach((table) => {
					const rows = table.querySelectorAll("tr");
					rows.forEach((row, rowIdx) => {
						const cells = row.querySelectorAll("td, th");
						cells.forEach((cell, colIdx) => {
							const text = cell.textContent || "";
							const match = text.match(SUBTABLE_REGEX);
							if (match) {
								const refName = (match[1] as string).trim();
								cell.empty();
								cell.addClass("has-subtable");

								const placeholder =
									cell.createSpan({
										cls: "subtable-placeholder",
									});
								placeholder.textContent = `▶ 子表格: ${refName}`;

								placeholder.addEventListener("click", async (e) => {
									e.stopPropagation();
									placeholder.textContent = "加载中...";
									try {
										const subData = await loadNestedTable(
											refName,
											this.app.vault,
											sourcePath,
											new Set<string>(),
											this.app
										);
										nestedCount.count++;
										const subContainer = renderNestedTable(
											subData,
											1,
											sourcePath,
											this.settings,
											this,
											nestedCount
										);
										cell.empty();
										cell.appendChild(subContainer);
									} catch {
										placeholder.textContent = "加载失败";
									}
								});
							}
						});
					});
				});
			}
		);

		let refreshTimeout: number | null = null;
		this.registerEvent(
			this.app.vault.on("modify", () => {
				if (refreshTimeout !== null) {
					clearTimeout(refreshTimeout);
				}
				refreshTimeout = window.setTimeout(() => {
					refreshTimeout = null;
				}, 500);
			})
		);

		this.addCommand({
			id: "insert-table-ref",
			name: "插入表格引用",
			editorCallback: (editor) => {
				const activeFile = this.app.workspace.getActiveFile();
				if (activeFile) {
					const fileName = activeFile.basename;
					editor.replaceSelection(`@table:${fileName}`);
				}
			},
		});

		this.addCommand({
			id: "refresh-nested-tables",
			name: "刷新所有嵌套表格",
			callback: () => {
				new Notice("嵌套表格将在下次渲染时刷新");
			},
		});
	}

	onunload() {
	}

	getActiveFilePath(): string {
		const file = this.app.workspace.getActiveFile();
		return file ? file.path : "";
	}

	refreshEditorExtensions() {
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		) as NestedTableSettings;
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}


}
