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
	filePath?: string;
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

		const result: NestedTableData = { headers, rows, subTables, filePath: resolvedPath };

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

		return result;
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

async function preloadEnriched(
	data: NestedTableData,
	depth: number,
	sourcePath: string,
	settings: NestedTableSettings,
	app: App,
	vault: Vault,
	nestedCount: { count: number }
): Promise<HTMLElement> {
	const container = document.createElement("div");
	container.className = `nested-table-container depth-${Math.min(depth, 4)}`;

	if (depth > settings.warnDepth) {
		const warning = container.createDiv({ cls: "subtable-depth-warning" });
		warning.textContent = `嵌套深度 ${depth}，超过警告阈值 ${settings.warnDepth}`;
	}

	if (depth >= settings.maxDepth) {
		const limitMsg = container.createDiv({ cls: "subtable-depth-warning" });
		limitMsg.textContent = `已到达最大嵌套深度 (${settings.maxDepth})，停止继续嵌套`;
		return container;
	}

	if (nestedCount.count >= MAX_NESTED_TABLE_COUNT) {
		const limitDiv = container.createDiv({ cls: "nested-table-limit-warning" });
		limitDiv.textContent = `嵌套表格数量超过限制 (${MAX_NESTED_TABLE_COUNT})，剩余表格已折叠`;
		return container;
	}

	const subPreloads: Promise<{ col: number; row: number; el: HTMLElement }>[] = [];
	for (const ref of data.subTables) {
		if (nestedCount.count >= MAX_NESTED_TABLE_COUNT) break;
		nestedCount.count++;
		const p = loadNestedTable(
			ref.sourcePath,
			vault,
			sourcePath,
			new Set<string>(),
			app
		).then((subData) =>
			preloadEnriched(subData, depth + 1, sourcePath, settings, app, vault, nestedCount)
		).then((el) => ({ col: ref.col, row: ref.row, el }));
		subPreloads.push(p);
	}

	const results = await Promise.all(subPreloads);

	const headerBar = container.createDiv({ cls: "nt-header-bar" });
	const title = headerBar.createSpan({ cls: "nt-header-title" });
	title.textContent = data.filePath || sourcePath;

	const btnGroup = headerBar.createDiv({ cls: "nt-header-buttons" });

	const editBtn = btnGroup.createEl("button", {
		cls: "clickable-icon nt-toolbar-btn",
		title: "编辑此表格",
	});
	editBtn.innerHTML = "✏️";
	editBtn.addEventListener("click", (e) => {
		e.stopPropagation();
		const filePath = data.filePath || sourcePath;
		new NestedTableEditModal(app, filePath).open();
	});

	const openBtn = btnGroup.createEl("button", {
		cls: "clickable-icon nt-toolbar-btn",
		title: "分窗口打开笔记",
	});
	openBtn.innerHTML = "📄";
	openBtn.addEventListener("click", (e) => {
		e.stopPropagation();
		const filePath = data.filePath || sourcePath;
		const file = vault.getAbstractFileByPath(filePath);
		if (file instanceof TFile) {
			const leaf = app.workspace.splitActiveLeaf();
			leaf.openFile(file);
		}
	});

	const table = container.createEl("table");
	const thead = table.createEl("thead");
	const headerRow = thead.createEl("tr");
	for (const header of data.headers) {
		headerRow.createEl("th", { text: header });
	}

	const tbody = table.createEl("tbody");
	for (let i = 0; i < data.rows.length; i++) {
		const row = data.rows[i] as string[];
		const tr = tbody.createEl("tr");
		for (let j = 0; j < data.headers.length; j++) {
			const cellValue = row[j] || "";
			const td = tr.createEl("td");
			const match = results.find((r) => r.row === i && r.col === j);
			if (match) {
				td.classList.add("has-subtable");
				td.dataset.nestedSource = data.subTables.find(
					(r) => r.row === i && r.col === j
				)?.sourcePath || "";
				td.dataset.nestedRow = String(i);
				td.dataset.nestedCol = String(j);
				td.appendChild(match.el);
				td.addEventListener("dblclick", () => {
					const ref = data.subTables.find((r) => r.row === i && r.col === j);
					if (ref) handleCellDoubleClick(ref.sourcePath, app);
				});
			} else {
				td.textContent = cellValue;
			}
		}
	}

	return container;
}

function handleCellDoubleClick(sourcePath: string, app: App) {
	new NestedTableEditModal(app, sourcePath).open();
}

class NestedTableEditModal extends Modal {
	private sourcePath: string;
	private hasUnsavedChanges = false;
	private activeFilePath: string;

	constructor(app: App, sourcePath: string) {
		super(app);
		this.sourcePath = sourcePath;
		this.titleEl.textContent = `编辑表格: ${sourcePath}`;
		this.activeFilePath = this.getActiveFilePath();
	}

	private getActiveFilePath(): string {
		const file = this.app.workspace.getActiveFile();
		return file ? file.path : "";
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.classList.add("nested-table-edit-modal");

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
			let file: TFile | null = null;

			if (this.sourcePath.includes("/") || this.sourcePath.endsWith(".md")) {
				const f = this.app.vault.getAbstractFileByPath(this.sourcePath);
				if (f instanceof TFile) file = f;
			} else {
				const resolved = this.app.metadataCache.getFirstLinkpathDest(
					this.sourcePath,
					this.getActiveFilePath()
				);
				if (resolved) {
					const f = this.app.vault.getAbstractFileByPath(resolved.path);
					if (f instanceof TFile) file = f;
				}
			}

			if (!file) {
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
		const currentHeaders = [...headers];
		const currentRows = rows.map((r) => {
			const padded = [...r];
			while (padded.length < colCount) padded.push(" ");
			return padded;
		});
		let filterText = "";

		const filterInput = container.createEl("input", {
			cls: "nt-edit-filter",
			type: "text",
			placeholder: "过滤行...",
		});
		filterInput.style.marginBottom = "8px";
		filterInput.style.width = "100%";
		filterInput.style.boxSizing = "border-box";

		const gridContainer = container.createDiv({ cls: "edit-grid" });

		const renderGrid = () => {
			gridContainer.empty();

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
				const row = currentRows[i] || [];
				const match = !filterText || row.some((cell) =>
					cell.toLowerCase().includes(filterText.toLowerCase())
				);
				for (let j = 0; j < totalCols; j++) {
					const input = gridContainer.createEl("input");
					input.type = "text";
					input.value = row[j] || " ";
					if (!match) input.classList.add("nt-row-filtered");
					input.addEventListener("input", () => {
						this.hasUnsavedChanges = true;
					});
				}
			}
		};

		const scrollEl = document.querySelector(".cm-scroller, .markdown-preview-view");
		const withScrollRestore = (fn: () => void) => {
			const saved = scrollEl ? scrollEl.scrollTop : 0;
			fn();
			if (saved > 0) requestAnimationFrame(() => { if (scrollEl) scrollEl.scrollTop = saved; });
		};

		filterInput.addEventListener("input", () => {
			filterText = filterInput.value;
			withScrollRestore(() => renderGrid());
		});

		withScrollRestore(() => renderGrid());

		const syncGridToArrays = () => {
			const inputs = Array.from(gridContainer.querySelectorAll("input"));
			const totalCols = currentHeaders.length;
			for (let i = 0; i < inputs.length; i++) {
				const inp = inputs[i] as HTMLInputElement;
				if (i < totalCols) {
					currentHeaders[i] = inp.value || " ";
				} else {
					const rowIdx = Math.floor((i - totalCols) / totalCols);
					const colIdx = (i - totalCols) % totalCols;
					if (!currentRows[rowIdx]) currentRows[rowIdx] = [];
					currentRows[rowIdx][colIdx] = inp.value || " ";
				}
			}
		};

		const toolbar = container.createDiv({ cls: "edit-toolbar" });

		const addRowBtn = toolbar.createEl("button", { text: "+ 行" });
		addRowBtn.addEventListener("click", () => {
			syncGridToArrays();
			currentRows.push(new Array(currentHeaders.length).fill(" "));
			withScrollRestore(() => renderGrid());
			this.hasUnsavedChanges = true;
		});

		const addColBtn = toolbar.createEl("button", { text: "+ 列" });
		addColBtn.addEventListener("click", () => {
			syncGridToArrays();
			currentHeaders.push("新列");
			for (const row of currentRows) {
				row.push(" ");
			}
			withScrollRestore(() => renderGrid());
			this.hasUnsavedChanges = true;
		});

		const removeRowBtn = toolbar.createEl("button", { text: "- 行" });
		removeRowBtn.addEventListener("click", () => {
			syncGridToArrays();
			if (currentRows.length <= 2) {
				new Notice("至少保留2行");
				return;
			}
			currentRows.pop();
			withScrollRestore(() => renderGrid());
			this.hasUnsavedChanges = true;
		});

		const removeColBtn = toolbar.createEl("button", { text: "- 列" });
		removeColBtn.addEventListener("click", () => {
			syncGridToArrays();
			if (currentHeaders.length <= 1) {
				new Notice("至少保留1列");
				return;
			}
			const lastIdx = currentHeaders.length - 1;
			currentHeaders.splice(lastIdx, 1);
			for (const row of currentRows) {
				row.splice(lastIdx, 1);
			}
			withScrollRestore(() => renderGrid());
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
			syncGridToArrays();
			await this.saveToFile([...currentHeaders], currentRows.map(r => [...r]));
		});
	}

	private async saveToFile(headers: string[], rows: string[][]) {
		try {
			let file: TFile | null = null;

			if (this.sourcePath.includes("/") || this.sourcePath.endsWith(".md")) {
				const f = this.app.vault.getAbstractFileByPath(this.sourcePath);
				if (f instanceof TFile) file = f;
			} else {
				const resolved = this.app.metadataCache.getFirstLinkpathDest(
					this.sourcePath,
					this.getActiveFilePath()
				);
				if (resolved) {
					const f = this.app.vault.getAbstractFileByPath(resolved.path);
					if (f instanceof TFile) file = f;
				}
			}

			if (!file) {
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

			const headerLine = "|" + headers.join("|") + "|";
			const tableStr = [headerLine, sepLine, ...dataLines].join("\n");

			let content = await this.app.vault.read(file);
			const tableRegex = /\|(.+)\|\s*\n\|[-| :]+\|\s*\n((?:\|.+\|\s*\n?)*)/;
			const tableMatch = content.match(tableRegex);
			if (tableMatch) {
				const fullMatch = tableMatch[0] as string;
				content = content.replace(fullMatch, tableStr);
			} else {
				new Notice("文件中没有找到 Markdown 表格");
				return;
			}

			const refName = this.sourcePath.replace(/\.md$/, "").replace(/^.*\//, "");
			let targetRowIndex = -1;
			const mainTable = document.querySelector("table.nt-main-table");
			if (mainTable) {
				const rows = mainTable.querySelectorAll("tbody tr");
				for (let i = 0; i < rows.length; i++) {
					const cell = rows[i]?.querySelector("td:nth-child(2)");
					if (cell && cell.textContent?.includes(`@table:${refName}`)) {
						targetRowIndex = i;
						break;
					}
				}
			}

			await this.app.vault.modify(file, content);

			if (targetRowIndex >= 0) {
				const scrollToRow = () => {
					const newTable = document.querySelector("table.nt-main-table");
					if (!newTable) return;
					const newRows = newTable.querySelectorAll("tbody tr");
					const target = newRows[targetRowIndex];
					if (target) target.scrollIntoView({ block: "center", behavior: "auto" });
				};
				requestAnimationFrame(() => requestAnimationFrame(scrollToRow));
			}

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

class FileSearchModal extends Modal {
	private onSelect: (name: string) => void;

	constructor(app: App, onSelect: (name: string) => void) {
		super(app);
		this.onSelect = onSelect;
		this.titleEl.textContent = "选择或创建笔记插入表格引用";
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		const searchInput = contentEl.createEl("input", {
			type: "text",
			placeholder: "搜索笔记名称...",
		});
		searchInput.style.width = "100%";
		searchInput.style.boxSizing = "border-box";
		searchInput.style.marginBottom = "8px";
		searchInput.style.padding = "6px 8px";
		searchInput.focus();
		searchInput.addEventListener("input", () => doRender(searchInput.value));

		const listEl = contentEl.createDiv();

		const createNew = contentEl.createDiv({ cls: "nt-file-search-create" });
		createNew.textContent = "+ 创建新笔记";
		createNew.addEventListener("click", () => {
			const name = searchInput.value.trim();
			if (!name) {
				new Notice("请输入笔记名称");
				return;
			}
			this.createAndSelect(name);
		});

		const doRender = (query: string) => {
			listEl.empty();

			const files = this.app.vault.getMarkdownFiles();
			const q = query.toLowerCase();
			const matched = q
				? files.filter((f) => f.basename.toLowerCase().includes(q))
				: files.slice(0, 50);

			if (matched.length === 0) {
				listEl.createDiv({
					text: q ? "未找到匹配笔记" : "（输入关键词搜索）",
					cls: "nt-file-search-result",
				});
				return;
			}

			for (const file of matched) {
				const el = listEl.createDiv({ cls: "nt-file-search-result" });
				el.textContent = file.basename;
				el.dataset.path = file.path;
				el.addEventListener("click", () => {
					this.onSelect(file.basename);
					this.close();
				});
			}
		};

		doRender("");

		searchInput.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				const name = searchInput.value.trim();
				if (!name) return;
				const exact = this.app.vault.getMarkdownFiles().find(
					(f) => f.basename.toLowerCase() === name.toLowerCase()
				);
				if (exact) {
					this.onSelect(exact.basename);
					this.close();
				} else {
					this.createAndSelect(name);
				}
			}
		});
	}

	private async createAndSelect(name: string) {
		const template = `|列1|列2|
|---|---|
|  |  |`;
		try {
			const file = await this.app.vault.create(
				`${name}.md`,
				template
			);
			new Notice(`已创建笔记: ${name}`);
			this.onSelect(file.basename);
			this.close();
		} catch (err) {
			new Notice(`创建失败: ${err instanceof Error ? err.message : "未知错误"}`);
		}
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

export default class NestedTablesPlugin extends Plugin {
	settings!: NestedTableSettings;
	private mutationObserver: MutationObserver | null = null;
	private processedTables = new WeakSet<HTMLTableElement>();
	private refreshTimeout: number | null = null;
	private isProcessing = false;
	private dataCache = new Map<string, NestedTableData>();

	async onload() {
		await this.loadSettings();

		this.addSettingTab(new NestedTableSettingTab(this.app, this));

		this.addCommand({
			id: "insert-table-ref",
			name: "插入表格引用",
			editorCallback: (editor) => {
				new FileSearchModal(this.app, (name) => {
					editor.replaceSelection(`@table:${name}`);
					this.processedTables = new WeakSet();
					this.dataCache.clear();
					this.preloadCurrentFile();
					setTimeout(() => this.scheduleRefresh(), 100);
				}).open();
			},
		});

		this.addCommand({
			id: "refresh-nested-tables",
			name: "刷新所有嵌套表格",
			callback: () => {
				this.scheduleRefresh();
				new Notice("嵌套表格已刷新");
			},
		});

		this.registerMarkdownPostProcessor(
			(el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
				const tables = Array.from(el.querySelectorAll("table"));
				if (tables.length === 0) return;

				for (const table of tables) {
					if (this.processedTables.has(table)) continue;
					this.processedTables.add(table);
					this.processTable(table, ctx.sourcePath, { count: 0 });
				}
			},
			-100
		);

		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				this.scheduleRefresh();
			})
		);

		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => {
				this.dataCache.clear();
				this.processedTables = new WeakSet();
				this.restartMutationObserver();
				this.preloadCurrentFile();
				setTimeout(() => this.processAllTables(), 300);
			})
		);

		this.registerEvent(
			this.app.vault.on("modify", () => {
				this.dataCache.clear();
				this.scheduleRefresh();
			})
		);

		this.startMutationObserver();
		this.scheduleRefresh();
	}

	private async preloadCurrentFile() {
		const file = this.app.workspace.getActiveFile();
		if (!file) return;
		try {
			const content = await this.app.vault.read(file);
			const tableRegex = /\|(.+)\|\s*\n\|[-| :]+\|\s*\n((?:\|.+\|\s*\n?)*)/g;
			let m: RegExpExecArray | null;
			const refNames = new Set<string>();
			while ((m = tableRegex.exec(content)) !== null) {
				const dataLines = (m[2] as string).trim().split("\n");
				for (const line of dataLines) {
					const cells = line.split("|").map(c => c.trim());
					for (const cell of cells) {
						const refMatch = cell.match(SUBTABLE_REGEX);
						if (refMatch) refNames.add(refMatch[1].trim());
					}
				}
			}
			const visited = new Set<string>([file.path]);
			for (const name of refNames) {
				if (this.dataCache.has(name)) continue;
				try {
					const data = await loadNestedTable(name, this.app.vault, file.path, visited, this.app);
					this.dataCache.set(name, data);
					await this.cacheNested(data, file.path, new Set(visited));
				} catch {
					// skip
				}
			}
		} catch {
			// skip
		}
	}

	private async cacheNested(data: NestedTableData, sourcePath: string, visited: Set<string>) {
		for (const ref of data.subTables) {
			if (this.dataCache.has(ref.sourcePath)) continue;
			try {
				const nested = await loadNestedTable(ref.sourcePath, this.app.vault, sourcePath, visited, this.app);
				this.dataCache.set(ref.sourcePath, nested);
				await this.cacheNested(nested, sourcePath, visited);
			} catch {
				// skip
			}
		}
	}

	private startMutationObserver() {
		const doObserve = () => {
			if (this.mutationObserver) this.mutationObserver.disconnect();
			this.mutationObserver = new MutationObserver(() => {
				if (this.isProcessing) return;
				this.processAllTables();
			});

			const target = document.querySelector(
				'.workspace-leaf-content[data-type="markdown"]'
			);
			if (target) {
				this.mutationObserver.observe(target, {
					childList: true,
					subtree: true,
				});
				return true;
			}
			return false;
		};

		if (!doObserve()) {
			const checkInterval = window.setInterval(() => {
				if (doObserve()) {
					clearInterval(checkInterval);
				}
			}, 500);
			this.registerInterval(checkInterval);
		}
	}

	private restartMutationObserver() {
		if (this.mutationObserver) {
			this.mutationObserver.disconnect();
		}
		this.mutationObserver = new MutationObserver(() => {
			if (this.isProcessing) return;
			this.processAllTables();
		});
		const targets = Array.from(document.querySelectorAll(
			'.workspace-leaf-content[data-type="markdown"]'
		));
		for (const target of targets) {
			this.mutationObserver.observe(target, {
				childList: true,
				subtree: true,
			});
		}
	}

	private scheduleRefresh() {
		if (this.refreshTimeout !== null) {
			clearTimeout(this.refreshTimeout);
		}
		this.refreshTimeout = window.setTimeout(() => {
			this.refreshTimeout = null;
			this.processAllTables();
		}, 500);
	}

	private async processAllTables() {
		if (this.isProcessing) return;
		this.isProcessing = true;

		try {
			const activeFile = this.app.workspace.getActiveFile();
			if (!activeFile) return;

			const sourcePath = activeFile.path;
			const leafContent = document.querySelector(
				'.workspace-leaf-content[data-type="markdown"]'
			);
			if (!leafContent) return;

			const tables = Array.from(leafContent.querySelectorAll("table"));
			const nestedCount = { count: 0 };

			for (const table of tables) {
				if (this.processedTables.has(table)) continue;
				this.processedTables.add(table);

				await this.processTable(table, sourcePath, nestedCount);
			}
		} finally {
			this.isProcessing = false;
		}
	}

	private async processTable(
		table: HTMLTableElement,
		sourcePath: string,
		nestedCount: { count: number }
	) {
		if (table.closest(".nested-table-container")) return;

		table.classList.add("nt-main-table");
		const refs: { cell: Element; wrapper: Element | null; refName: string }[] = [];

		const rows = Array.from(table.querySelectorAll("tr"));
		for (const row of rows) {
			const cells = Array.from(row.querySelectorAll("td, th"));
			for (const cell of cells) {
				const cellWrapper = (cell as HTMLElement).querySelector(".table-cell-wrapper");
				const textEl = cellWrapper || cell;
				const text = textEl.textContent || "";
				const match = text.match(SUBTABLE_REGEX);
				if (match) {
					const refName = (match[1] as string).trim();
					refs.push({ cell, wrapper: cellWrapper, refName });
				}
			}
		}

		if (refs.length === 0) return;

		for (const ref of refs) {
			const targetEl = ref.wrapper || ref.cell;
			targetEl.classList.add("has-subtable", "nt-unprocessed");
		}

		const loaded = await Promise.all(
			refs.map((ref) => {
				const cached = this.dataCache.get(ref.refName);
				const dataPromise = cached
					? Promise.resolve(cached)
					: loadNestedTable(ref.refName, this.app.vault, sourcePath, new Set<string>(), this.app);
				return dataPromise.then(async (subData) => {
					nestedCount.count++;
					const enriched = await preloadEnriched(
						subData, 1, sourcePath, this.settings, this.app, this.app.vault, nestedCount
					);
					return { ref, el: enriched };
				});
			})
		);

		for (const { ref, el } of loaded) {
			const targetEl = ref.wrapper || ref.cell;
			targetEl.classList.remove("nt-unprocessed");
			targetEl.empty();
			targetEl.classList.add("has-subtable");
			targetEl.appendChild(el);
		}
	}

	getActiveFilePath(): string {
		const file = this.app.workspace.getActiveFile();
		return file ? file.path : "";
	}

	refreshEditorExtensions() {
	}

	async loadSettings() {
		const saved = await this.loadData() as Partial<NestedTableSettings> | null;
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			saved || {}
		) as NestedTableSettings;
		if (saved && saved.maxDepth !== undefined && saved.maxDepth < 6) {
			this.settings.maxDepth = 10;
			await this.saveSettings();
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
