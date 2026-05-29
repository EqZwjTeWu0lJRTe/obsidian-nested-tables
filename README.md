# Nested Tables

Obsidian 嵌套表格插件。在 Markdown 表格单元格中使用 `@table:文件名` 语法引用子表格，自动展开为可交互的嵌套结构。

## 用法

在表格单元格中输入 `@table:文件名`：

```
| 维度 | 内容                 |
|------|----------------------|
| 定义 | @table:定义          |
| 病因 | @table:病因          |
```

插件会自动加载 `定义.md` 和 `病因.md` 中的 Markdown 表格并渲染在单元格内。

## 功能

- **自动展开**：`@table:xxx` 自动加载并渲染子表格，无需点击
- **编辑模式支持**：阅读模式和编辑模式均可正常渲染
- **工具栏**：每层嵌套右上角有 `✏️ 📄` 按钮（hover 显示）
  - ✏️ 编辑：打开编辑模态框，修改子表内容
  - 📄 打开：在分窗口中打开子表笔记
- **编辑模态框**：
  - 行过滤：输入关键词实时过滤行
  - 增删行/列：`+ 行` `+ 列` `- 行` `- 列`
  - 自动保存
- **文件搜索插入**：
  - 命令面板 `插入表格引用` 打开文件搜索弹窗
  - 模糊搜索笔记名称
  - 支持创建新笔记（带表格模板）
  - 支持快捷键绑定
- **嵌套深度控制**：默认最大 6 层，深度递缩字体与列宽
- **循环引用检测**
- **列宽自适**应：容器包裹 + 固定 max-width + 水平滚动

## 安装

### BRAT（推荐）

1. 安装 [BRAT](https://obsidian.md/plugins?id=obsidian42-brat) 插件
2. 在 BRAT 设置中添加 `EqZwjTeWu0lJRTe/obsidian-nested-tables`
3. 启用 `Nested Tables` 插件

### 手动

从 [Releases 页面](https://github.com/EqZwjTeWu0lJRTe/obsidian-nested-tables/releases) 下载 `main.js`、`manifest.json`、`styles.css`，放到 `.obsidian/plugins/obsidian-nested-tables/` 目录。

## 开发

```bash
git clone https://github.com/EqZwjTeWu0lJRTe/obsidian-nested-tables
cd obsidian-nested-tables
npm install
npm run build     # 构建
npm run dev       # 监听模式
```

## 提交规范

```
feat: xxx  新功能
fix: xxx   修复
chore: xxx 构建/配置
```

## 版本

已发布版本见 [Releases 页面](https://github.com/EqZwjTeWu0lJRTe/obsidian-nested-tables/releases)。
