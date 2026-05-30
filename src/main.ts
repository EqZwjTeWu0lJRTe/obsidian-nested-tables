import {
	App,
	Component,
	MarkdownPostProcessorContext,
	MarkdownRenderer,
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
	tableName?: string;
}

interface TableData {
	headers: string[];
	rows: string[][];
	subTables: SubTableRef[];
	filePath?: string;
	tableName?: string;
}

type NestedTableData = TableData;

const SUBTABLE_REGEX = /^@table:(.+?)(?:#(.+))?$/;
const TABLE_REGEX = /\|(.+)\|\s*\n\|[-| :]+\|\s*\n((?:\|.+\|\s*\n?)*)/g;

const MAX_NESTED_TABLE_COUNT = 50;

function cacheKey(name: string, tableName?: string): string {
	return tableName ? `${name}#${tableName}` : name;
}

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
	app: App,
	tableName?: string
): Promise<NestedTableData> {
	const headers: string[] = [];
	const rows: string[][] = [];
	const subTables: SubTableRef[] = [];

	try {
		let resolved = app.metadataCache.getFirstLinkpathDest(
			sourcePath,
			currentPath
		);
		let resolvedPath: string | undefined;
		if (resolved) {
			resolvedPath = resolved.path;
		} else {
			// Fallback: search by basename across the vault
			const candidates = app.vault.getMarkdownFiles().filter(f =>
				f.basename === sourcePath || f.path === sourcePath || f.path === sourcePath + ".md"
			);
			if (candidates.length > 0) resolvedPath = candidates[0].path;
		}
		if (!resolvedPath) {
			return {
				headers: ["错误"],
				rows: [[`未找到文件: ${escapeHtml(sourcePath)}`]],
				subTables: [],
			};
		}

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

		interface TableEntry { headers: string[]; dataLines: string[]; startIndex: number }
		const allTables: TableEntry[] = [];
		TABLE_REGEX.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = TABLE_REGEX.exec(content)) !== null) {
			const hdrs = (m[1] as string).split("|").map(h => h.trim()).filter(h => h.length > 0);
			const lines = (m[2] as string).trim().split("\n");
			allTables.push({ headers: hdrs, dataLines: lines, startIndex: m.index });
		}

		if (allTables.length === 0) {
			return {
				headers: ["提示"],
				rows: [[`${escapeHtml(sourcePath)} 中没有找到 Markdown 表格`]],
				subTables: [],
			};
		}

		// Parse headings and map each table to its nearest preceding heading
		const headingLines: { text: string; lineNum: number }[] = [];
		const allLines = content.split("\n");
		for (let i = 0; i < allLines.length; i++) {
			const hm = allLines[i].match(/^#{1,6}\s+(.+)/);
			if (hm) headingLines.push({ text: hm[1].trim(), lineNum: i });
		}

		function findHeadingForTable(tableStartIdx: number): string | undefined {
			const tableLine = content.slice(0, tableStartIdx).split("\n").length - 1;
			let best: string | undefined;
			for (const h of headingLines) {
				if (h.lineNum < tableLine) best = h.text;
				else break;
			}
			return best;
		}

		let tableIndex = 0;
		if (tableName) {
			const lowerName = tableName.toLowerCase();
			// Try matching by heading first
			let idx = allTables.findIndex(t => {
				const heading = findHeadingForTable(t.startIndex);
				return heading?.toLowerCase() === lowerName;
			});
			// Fallback: match by table header cell
			if (idx === -1) {
				idx = allTables.findIndex(t =>
					t.headers.some(h => h.toLowerCase() === lowerName)
				);
			}
			if (idx === -1) {
				return {
					headers: ["错误"],
					rows: [[`未找到表"${escapeHtml(tableName)}": ${escapeHtml(sourcePath)}`]],
					subTables: [],
				};
			}
			tableIndex = idx;
		}

		const { headers: rawHeaders, dataLines } = allTables[tableIndex];
		const validHeaders = rawHeaders;
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

		const result: NestedTableData = { headers, rows, subTables, filePath: resolvedPath, tableName };

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
					const refName = (match[1] as string).trim();
					const refTable = (match[2] || "").trim() || undefined;
					subTables.push({
						row: i,
						col: j,
						sourcePath: refName.trim(),
						tableName: refTable,
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
			app,
			ref.tableName
		).then((subData) =>
			preloadEnriched(subData, depth + 1, sourcePath, settings, app, vault, nestedCount)
		).then((el) => ({ col: ref.col, row: ref.row, el }));
		subPreloads.push(p);
	}

	const results = await Promise.all(subPreloads);

	const headerBar = container.createDiv({ cls: "nt-header-bar" });
	const title = headerBar.createSpan({ cls: "nt-header-title" });
	title.textContent = data.filePath || sourcePath;
	if (data.tableName) title.textContent += ` #${data.tableName}`;

	const btnGroup = headerBar.createDiv({ cls: "nt-header-buttons" });

	const editBtn = btnGroup.createEl("button", {
		cls: "clickable-icon nt-toolbar-btn",
		title: "编辑此表格",
	});
	editBtn.innerHTML = "✏️";
	editBtn.addEventListener("click", (e) => {
		e.stopPropagation();
		const filePath = data.filePath || sourcePath;
		new NestedTableEditModal(app, filePath, data.tableName).open();
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
	const renderTasks: Promise<void>[] = [];
	const renderComp = new Component();
	renderComp.load();
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
					if (ref) handleCellDoubleClick(ref.sourcePath, app, ref.tableName);
				});
			} else {
				renderTasks.push(
					MarkdownRenderer.render(app, cellValue, td, sourcePath, renderComp)
				);
			}
		}
	}

	await Promise.all(renderTasks);

	return container;
}

function handleCellDoubleClick(sourcePath: string, app: App, tableName?: string) {
	new NestedTableEditModal(app, sourcePath, tableName).open();
}

class NestedTableEditModal extends Modal {
	private sourcePath: string;
	private tableName?: string;
	private hasUnsavedChanges = false;
	private activeFilePath: string;
	private loadedMtime: number = 0;
	private editingTableIndex: number = 0;

	constructor(app: App, sourcePath: string, tableName?: string) {
		super(app);
		this.sourcePath = sourcePath;
		this.tableName = tableName;
		this.titleEl.textContent = `编辑表格: ${sourcePath}${tableName ? ` #${tableName}` : ""}`;
		this.activeFilePath = this.getActiveFilePath();
		(this as any).bgEl.style.pointerEvents = "none";
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.classList.add("nested-table-edit-modal");

		const closeBtn = contentEl.createEl("button", {
			cls: "nt-modal-close",
			text: "✕",
		});
		closeBtn.addEventListener("click", () => this.close());

		contentEl.addEventListener("dragover", (e) => {
			e.preventDefault();
		});

		contentEl.addEventListener("drop", (e) => {
			e.preventDefault();
			const text = e.dataTransfer?.getData("text/plain");
			const val = text || e.dataTransfer?.files[0]?.name || "";
			if (val) {
				const activeInput = contentEl.querySelector("input:focus") as HTMLInputElement;
				if (activeInput) {
					activeInput.value += val;
					this.hasUnsavedChanges = true;
				}
			}
		});

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

	private getActiveFilePath(): string {
		const file = this.app.workspace.getActiveFile();
		return file ? file.path : "";
	}

	private async loadTableData(): Promise<{
		headers: string[];
		rows: string[][];
	} | null> {
		try {
			let file: TFile | null = null;

			const exactPath = this.app.vault.getAbstractFileByPath(
				this.sourcePath.endsWith(".md") ? this.sourcePath : this.sourcePath + ".md"
			);
			if (exactPath instanceof TFile) {
				file = exactPath;
				this.loadedMtime = file.stat.mtime;
			} else {
				const resolved = this.app.metadataCache.getFirstLinkpathDest(
					this.sourcePath,
					this.getActiveFilePath()
				);
				if (resolved) {
					const f = this.app.vault.getAbstractFileByPath(resolved.path);
					if (f instanceof TFile) { file = f; this.loadedMtime = f.stat.mtime; }
				}
				if (!file) {
					const candidates = this.app.vault.getMarkdownFiles().filter(f =>
						f.basename === this.sourcePath
					);
					if (candidates.length > 0) {
						file = candidates[0];
						this.loadedMtime = file.stat.mtime;
					}
				}
			}

			if (!file) {
				new Notice(`未找到文件: ${this.sourcePath}`);
				return null;
			}

			const content = await this.app.vault.read(file);

			interface TableEntry { headers: string[]; dataLines: string[]; startIndex: number }
			const allTables: TableEntry[] = [];
			TABLE_REGEX.lastIndex = 0;
			let m: RegExpExecArray | null;
			while ((m = TABLE_REGEX.exec(content)) !== null) {
				const hdrs = (m[1] as string).split("|").map(h => h.trim()).filter(h => h.length > 0);
				const lines = (m[2] as string).trim().split("\n");
				allTables.push({ headers: hdrs, dataLines: lines, startIndex: m.index });
			}

			if (allTables.length === 0) {
				new Notice("文件中没有找到 Markdown 表格");
				return null;
			}

			const headingLines: { text: string; lineNum: number }[] = [];
			const allLines = content.split("\n");
			for (let i = 0; i < allLines.length; i++) {
				const hm = allLines[i].match(/^#{1,6}\s+(.+)/);
				if (hm) headingLines.push({ text: hm[1].trim(), lineNum: i });
			}

			function findHeadingForTable(tableStartIdx: number): string | undefined {
				const tableLine = content.slice(0, tableStartIdx).split("\n").length - 1;
				let best: string | undefined;
				for (const h of headingLines) {
					if (h.lineNum < tableLine) best = h.text;
					else break;
				}
				return best;
			}

			this.editingTableIndex = 0;
			if (this.tableName) {
				const lowerName = this.tableName.toLowerCase();
				let idx = allTables.findIndex(t => {
					const heading = findHeadingForTable(t.startIndex);
					return heading?.toLowerCase() === lowerName;
				});
				if (idx === -1) {
					idx = allTables.findIndex(t =>
						t.headers.some(h => h.toLowerCase() === lowerName)
					);
				}
				if (idx === -1) {
					new Notice(`未找到表"${this.tableName}"`);
					return null;
				}
				this.editingTableIndex = idx;
			}

			const { headers: rawHeaders, dataLines } = allTables[this.editingTableIndex];
			const headers = [...rawHeaders];

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

			const exactPath = this.app.vault.getAbstractFileByPath(
				this.sourcePath.endsWith(".md") ? this.sourcePath : this.sourcePath + ".md"
			);
			if (exactPath instanceof TFile) {
				file = exactPath;
			} else {
				const resolved = this.app.metadataCache.getFirstLinkpathDest(
					this.sourcePath,
					this.getActiveFilePath()
				);
				if (resolved) {
					const f = this.app.vault.getAbstractFileByPath(resolved.path);
					if (f instanceof TFile) file = f;
				}
				if (!file) {
					const candidates = this.app.vault.getMarkdownFiles().filter(f =>
						f.basename === this.sourcePath
					);
					if (candidates.length > 0) file = candidates[0];
				}
			}

			if (!file) {
				new Notice(`未找到文件: ${this.sourcePath}`);
				return;
			}

			if (file.stat.mtime !== this.loadedMtime) {
				const conflict = new Notice("文件已被外部修改，是否覆盖？点「取消」放弃更改", 0);
				const overwrite = await new Promise<boolean>((resolve) => {
					const noticeEl = conflict.noticeEl;
					const cancelBtn = noticeEl.createEl("button", { text: "取消" });
					cancelBtn.onclick = () => resolve(false);
					const okBtn = noticeEl.createEl("button", { text: "覆盖" });
					okBtn.onclick = () => resolve(true);
				});
				if (!overwrite) {
					conflict.hide();
					return;
				}
				conflict.hide();
			}

			const sepLine = "|" + headers.map(() => "---").join("|") + "|";
			const dataLines = rows.map(
				(row) =>
					"|" +
					row.map((cell) => cell || " ").join("|") +
					"|"
			);

			const headerLine = "|" + headers.join("|") + "|";
			const newTableStr = [headerLine, sepLine, ...dataLines].join("\n");

			const oldContent = await this.app.vault.read(file);

			if (this.tableName) {
				let newContent = "";
				let count = 0;
				let lastIdx = 0;
				let replaced = false;
				TABLE_REGEX.lastIndex = 0;
				let m: RegExpExecArray | null;
				while ((m = TABLE_REGEX.exec(oldContent)) !== null) {
					newContent += oldContent.slice(lastIdx, m.index);
					if (count === this.editingTableIndex) {
						newContent += newTableStr;
						replaced = true;
					} else {
						newContent += m[0];
					}
					lastIdx = TABLE_REGEX.lastIndex;
					count++;
				}
				newContent += oldContent.slice(lastIdx);

				if (!replaced) {
					new Notice("文件中没有找到匹配的表格");
					return;
				}

				await this.app.vault.modify(file, newContent);
			} else {
				const tableRegex = /\|(.+)\|\s*\n\|[-| :]+\|\s*\n((?:\|.+\|\s*\n?)*)/;
				const newContent = oldContent.replace(tableRegex, newTableStr);
				if (newContent === oldContent) {
					new Notice("文件中没有找到 Markdown 表格");
					return;
				}
				await this.app.vault.modify(file, newContent);
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
				setTimeout(() => this.processAllTables(), 200);
			})
		);

		this.registerEvent(
			this.app.vault.on("modify", (file: any) => {
				this.dataCache.clear();
				this.processedTables = new WeakSet();
				// Restore cells to @table: text so re-processing can find references
				const leaf = document.querySelector('.workspace-leaf-content[data-type="markdown"]');
				if (leaf) {
					leaf.querySelectorAll('[data-nt-original-ref]').forEach(el => {
						const cell = el as HTMLElement;
						const ref = cell.getAttribute('data-nt-original-ref') || '';
						cell.removeAttribute('data-nt-original-ref');
						cell.classList.remove('has-subtable');
						cell.textContent = ref;
					});
				}
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
			const refs: { name: string; tableName?: string }[] = [];
			TABLE_REGEX.lastIndex = 0;
			let m: RegExpExecArray | null;
			while ((m = TABLE_REGEX.exec(content)) !== null) {
				const dataLines = (m[2] as string).trim().split("\n");
				for (const line of dataLines) {
					const cells = line.split("|").map(c => c.trim());
					for (const cell of cells) {
						const refMatch = cell.match(SUBTABLE_REGEX);
						if (refMatch) {
							const name = refMatch[1].trim();
							const tableName = (refMatch[2] || "").trim() || undefined;
							refs.push({ name, tableName });
						}
					}
				}
			}
			const visited = new Set<string>([file.path]);
			for (const ref of refs) {
				const key = cacheKey(ref.name, ref.tableName);
				if (this.dataCache.has(key)) continue;
				try {
					const data = await loadNestedTable(ref.name, this.app.vault, file.path, visited, this.app, ref.tableName);
					this.dataCache.set(key, data);
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
			const key = cacheKey(ref.sourcePath, ref.tableName);
			if (this.dataCache.has(key)) continue;
			try {
				const nested = await loadNestedTable(ref.sourcePath, this.app.vault, sourcePath, visited, this.app, ref.tableName);
				this.dataCache.set(key, nested);
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
		}, 200);
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
				if (table.closest(".nested-table-container")) continue;
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
		const refs: { cell: Element; wrapper: Element | null; refName: string; tableName?: string; matchText: string }[] = [];

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
					const tableName = (match[2] || "").trim() || undefined;
					refs.push({ cell, wrapper: cellWrapper, refName, tableName, matchText: match[0] });
				}
			}
		}

		if (refs.length === 0) return;

		for (const ref of refs) {
			const targetEl = ref.wrapper || ref.cell;
			targetEl.classList.add("has-subtable");
			(targetEl as HTMLElement).dataset.ntOriginalRef = ref.matchText;
			targetEl.addEventListener("dblclick", (e) => {
				e.stopPropagation();
				if (!targetEl.querySelector(".nested-table-container")) {
					handleCellDoubleClick(ref.refName, this.app, ref.tableName);
				}
			});
		}

		const loaded = await Promise.all(
			refs.map((ref) => {
				const key = cacheKey(ref.refName, ref.tableName);
				const cached = this.dataCache.get(key);
				const dataPromise = cached
					? Promise.resolve(cached)
					: loadNestedTable(ref.refName, this.app.vault, sourcePath, new Set<string>(), this.app, ref.tableName);
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
