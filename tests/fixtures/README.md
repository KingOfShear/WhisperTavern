# tests/fixtures —— 测试金样与录制回放资产(**只读**)

本目录收**测试专用资产**:provider 录制回放 fixture(provider-adapter-spec §20,T1–T14)、
金样编译快照等。**目录内一切文件对会话/工具链只读**:测试与录制脚本可以读,禁止改写;
需要变更 = 新增文件 + 更新本 README 登记,不许原地覆盖(金样被覆盖 = 回归基线被销毁)。

## 真实资产红线(AGENTS.md §7 / 横切纪律 X3)

- 仓库根目录的用户真实资产(`酒馆参考文件/`、根目录 json 预设等)是**生态参照与测试金样**,
  勿修改、勿上传;需要它们参与测试时,经脱敏后**复制**进本目录。
- **密钥零泄漏(PV5)**:任何 fixture 不得含真实 API key / Authorization / api-key 头 /
  URL query 密钥;录制脚本统一过 adapters 的 redact 中间件(provider-adapter-spec §17.2),
  密钥字段一律替换为 `[redacted]`。
- **用户内容脱敏**:涉及私人对话、真实角色卡正文时,替换为结构等价的合成文本——
  fixture 的价值在**协议形状与字节序列**,不在内容本身。
- fixture 命名:`provider/<provider-id>/<case-id>-<名称>.<ext>`,case-id 对齐 §20 的 T 编号
  (如 `provider/openai-compat/T1-basic-stream.jsonl`)。

## 子目录

- `provider/` —— adapter 契约测试 fixture(§20 必测集:T1/T4/T6/T10/T11/T12 ×
  openai-compat / anthropic / gemini,T14 以重复回放断言实现)。
  **P0 内容为合成字节流**(无真实密钥、合成文本),由 `provider/record-fixtures.mjs`
  确定性生成——变更 fixture = 改脚本重跑,不手改 JSON;接入真实 API 录制后,
  录制流程必须过 adapters 的 redact 中间件(§17.2)再落盘。
  回放器:`@whispertavern/adapters` 的 `loadFixture / fixtureTransport / fixtureRequest`。
