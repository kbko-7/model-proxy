# model-proxy

本地桌面应用：托盘常驻 + 原生窗口，把 Claude Code / Codex 等客户端的请求转发到你配置的后端模型，并在窗口里自由切换模型。

## 组成

| 文件 | 作用 |
| --- | --- |
| `server.mjs` | 代理内核（Node）：路由 / 改写模型 / 鉴权注入 / 模型发现 / 设置接口 |
| `translate.mjs` | 协议翻译层：Anthropic Messages ↔ OpenAI Chat Completions ↔ Responses（含流式） |
| `app.py` | 桌面壳（Python）：托盘 + 原生 WebView 窗口，拉起内核并渲染控制台 |
| `panel.html` | 控制台界面（FlClash 风格，由内核在 `127.0.0.1:8787` 提供） |
| `config.yaml` | provider 定义 + 运行配置（窗口「⚙ 设置」里改，也可手改） |
| `config.example.yaml` | 脱敏配置模板（含 OpenAI 后端示例） |
| `state.json` | 运行时状态（自动生成，记录当前选中模型） |
| `start.vbs` | 无黑窗启动器 |
| `debug.cmd` | 带控制台的调试启动（能看内核日志） |
| `icon.ico` | 应用图标（桌面快捷方式用） |
| `test-translate.mjs` / `test-e2e.mjs` | 翻译层单测 / 端到端冒烟测试（`node test-*.mjs`） |

## 启动

- **正常用法**：双击桌面「model-proxy」快捷方式，或 `start.vbs` —— 无任何控制台窗口
- **调试**：双击 `debug.cmd`（有控制台，显示 node 内核日志）
- 关窗 = 缩到托盘；托盘菜单：打开面板 / 退出

所有配置都在窗口里完成（⚙ 设置）：
- **监听地址**（host / port）：保存后自动重启监听，窗口自动跳到新地址
- **对外 api-key**：留空 = 仅本机免密钥；设置后所有 `/v1` 与 `/api` 请求都要带这个 key
- **每个 provider**：显示名 / 协议（anthropic·openai）/ baseURL / 鉴权头（headers 键值对，可增删）——例如 CANNBot 的 JWT 每 24 小时过期，在 `Authorization` 头里直接换即可，不用改文件
- **模型列表**在设置里只读展示，增删模型 / 增删 provider 请手改 `config.yaml`

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
    "ANTHROPIC_MODEL": "model-proxy"
  }
}
```

- 模型在窗口里点选（全局默认，立即生效）
- 也可在 Claude Code 里 `/model` 选择（发现接口会列出全部模型）
- **若设置了对外 api-key**：把 Claude Code 的 `ANTHROPIC_AUTH_TOKEN` 填成同一个 key

## 多协议接入（Codex / 通用 OpenAI 客户端）

代理在同一个端口同时暴露三套前端协议，前后端协议不同时自动翻译（含流式）：

| 前端 | 端点 | 说明 |
| --- | --- | --- |
| Claude Code | `POST /v1/messages` | Anthropic Messages |
| Codex | `POST /v1/responses` | OpenAI Responses（Codex CLI 默认协议） |
| 通用 OpenAI 工具 | `POST /v1/chat/completions` | OpenAI Chat Completions |

后端 provider 用 `protocol` 声明协议（`anthropic` 或 `openai`），代理会按需互译：

- Claude Code → OpenAI 后端：Messages ↔ Chat Completions
- Codex → 任意后端：Responses ↔ Chat Completions / Messages
- OpenAI 工具 → Anthropic 后端：Chat Completions ↔ Messages

**接 Codex**（`~/.codex/config.toml`）：

```toml
[model_providers.cannbot]
name = "model-proxy"
base_url = "http://127.0.0.1:8787/v1"
wire_api = "responses"

[profiles.default]
model = "cannbot/deepseek-v4-pro"
model_provider = "cannbot"
```

模型 id 用 `provider/模型id`（与 `/v1/models` 返回一致），留空则由面板默认模型兜底。

**加一个 OpenAI 后端**：在 `config.yaml` 的 `providers` 下加（参考 `config.example.yaml` 里注释掉的 `openai` 示例）：

```yaml
  openai:
    displayName: OpenAI
    protocol: openai
    baseURL: https://api.openai.com/v1   # 或 http://localhost:8000/v1（vLLM/Ollama）
    headers:
      Authorization: Bearer sk-xxx
    models:
      - id: gpt-4o
        name: GPT-4o
        contextWindow: 128000
```

`baseURL` 要写成「再拼 `/chat/completions` 就完整」的地址（OpenAI 官方是 `.../v1`）。本地 http 后端（vLLM/Ollama）直接写 `http://...` 即可。

## 行为细节

- 收到的请求若未指定可识别的模型（如 `model-proxy`、`claude-sonnet-*` 等），一律用窗口里选中的默认模型
- 孤儿保护：桌面壳意外退出时，内核自动退出，不残留占用端口
- JWT 剩余时间在「状态」卡片实时显示，少于 1 小时变黄提醒

## 安全

`config.yaml` 含明文密钥，请勿外传。默认仅监听 `127.0.0.1`；要局域网共享时：设置里把 host 改成 `0.0.0.0` **并**设置 api-key。