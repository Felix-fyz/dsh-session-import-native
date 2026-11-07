# 导入 DeepSeek 自己的对话

DeepSeek Harness（dsh）插件：把 **dsh 自己保存的会话日志**（`session.v4.jsonl.zstd`）从任意文件夹导入当前配置，
导入后直接出现在侧边栏对应工作区里，可以点开续聊。

> Import DeepSeek Harness's **own** session logs — the multi-frame Zstandard JSONL files under
> `~/.dsh/sessions` — from any folder or backup, into the current profile. Imported sessions land in
> the sidebar under their original workspace and can be continued immediately. The Web UI is
> Chinese-only; the Host API and the `/dsh-import` command are locale-neutral.

与市面上的 `dsh-plugin-session-import` 不同：那个插件导入的是 claude-code / codex / reasonix / zcode 的记录，
**不识别 dsh 自己的日志**；本插件专门处理 dsh 原生格式。

## 用法

1. 侧边栏底部点「⇩ 导入 DeepSeek 对话」。
2. 选择 sessions 目录（默认 `~/.dsh/sessions`；桌面上的 `sessions`、`sessions11`、`sessions - 副本` 会自动列为常用位置）。
3. 勾选会话 → 导入。
4. 也可以在对话框里直接输入某一条 `session.v4.jsonl.zstd` 的完整路径。

命令方式：

```text
/dsh-import C:\Users\me\Desktop\sessions
/dsh-import C:\Users\me\Desktop\sessions\--C-...--\session-xxxx\session.v4.jsonl.zstd
```

## 导入行为

| 项目 | 说明 |
|---|---|
| 会话编号 | 每条记录生成新的 `session-<uuid>`，不会覆盖现有会话，同一份日志可重复导入 |
| 工作区 | 原日志记录的 `cwd` 目录存在时导入该工作区；否则落到默认工作区目录，并自动挂到侧边栏 |
| 内容 | 保留用户/助手消息、思考、工具调用与结果、标题、轮次结构 |
| 丢弃 | 其他插件/版本的运行时事件（job、投递回执、重试标记、审批卡片、检索请求等），避免旧版本词汇导致回放失败 |
| 附件 | 图片与文件是另一份配置里的附件 ID，导入时降级为 `[图片]` / `[附件：名称]` 占位文本 |
| 去重提示 | 导入台账记录在 `~/.dsh/session-import-native/imported.json`，列表里显示「已导入」徽标（仍可再导一次） |
| 版本 | 仅支持 v4 日志（当前 dsh 版本写出的格式） |

## 安装

```text
plugin_manager install_bundle  <绝对路径>\dsh-session-import-native
```

或把本目录作为本地 bundle 安装到当前 profile；安装后由 HMR 生效。

## 开发

插件分两半：`index.js` 是 Host（Node，无构建步骤），`client.js` 是浏览器模块（CommonJS 工厂，由
`window.__ModuleLoader__` 注册）。改完文件后：

- 改 Host：在插件管理里把该插件关闭再打开，`apply` 会用新代码重跑；
- 改 Client：刷新页面（HMR 需要 `pnpm run dev:web` 在跑才会自动重载）。

## License

MIT
