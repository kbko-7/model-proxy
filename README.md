# CANNBot 模型代理

本地桌面应用：托盘常驻 + 原生窗口，把 Claude Code 的请求转发到 CANNBot，并在窗口里自由切换模型。

## 组成

| 文件 | 作用 |
| --- | --- |
| `server.mjs` | 代理内核（Node）：转发 / 改写模型 / 鉴权注入 / 模型发现 / 设置接口 |
| `app.py` | 桌面壳（Python）：托盘 + 原生 WebView 窗口，拉起内核并渲染控制台 |
| `panel.html` | 控制台界面（FlClash 风格，由内核在 `127.0.0.1:8787` 提供） |
| `config.yaml` | provider 定义 + 运行配置（窗口「⚙ 设置」里改，也可手改） |
| `state.json` | 运行时状态（自动生成，记录当前选中模型） |
| `start.vbs` | 无黑窗启动器 |
| `debug.cmd` | 带控制台的调试启动（能看内核日志） |
| `icon.ico` | 应用图标（桌面快捷方式用） |

## 启动

- **正常用法**：双击桌面「CANNBot 模型代理」快捷方式，或 `start.vbs` —— 无任何控制台窗口
- **调试**：双击 `debug.cmd`（有控制台，显示 node 内核日志）
- 关窗 = 缩到托盘；托盘菜单：打开面板 / 退出

所有配置都在窗口里完成（⚙ 设置）：
- **监听地址**（host / port）：保存后自动重启监听，窗口自动跳到新地址
- **对外 api-key**：留空 = 仅本机免密钥；设置后所有 `/v1` 与 `/api` 请求都要带这个 key
- **各 provider 鉴权**（JWT + x-api-vkey）：CANNBot 的 JWT 每 24 小时过期，直接在窗口里换，不用改文件

## 安装（已完成）

```bash
npm install                                  # 内核依赖（yaml）
.venv 已建好（Python 3.12 + pywebview/pystray/pillow/pythonnet）
```

## 接入 Claude Code

在 `~/.claude/settings.json` 里加：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787",
    "ANTHROPIC_MODEL": "cannbot-proxy"
  }
}
```

- 模型在窗口里点选（全局默认，立即生效）
- 也可在 Claude Code 里 `/model` 选择（发现接口会列出全部模型）
- **若设置了对外 api-key**：把 Claude Code 的 `ANTHROPIC_AUTH_TOKEN` 填成同一个 key

## 行为细节

- 收到的请求若未指定可识别的模型（如 `cannbot-proxy`、`claude-sonnet-*` 等），一律用窗口里选中的默认模型
- 孤儿保护：桌面壳意外退出时，内核自动退出，不残留占用端口
- JWT 剩余时间在「状态」卡片实时显示，少于 1 小时变黄提醒

## 安全

`config.yaml` 含明文密钥，请勿外传。默认仅监听 `127.0.0.1`；要局域网共享时：设置里把 host 改成 `0.0.0.0` **并**设置 api-key。