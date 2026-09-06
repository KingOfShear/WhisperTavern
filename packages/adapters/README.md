# @whispertavern/adapters

Provider Adapter 层:**只翻译,不做语义**(PV1)——不改内容字节、不裁剪、不重排;
语义修改权唯一在 Prompt Compiler。规格真相源:
[provider-adapter-spec](../../docs/specs/provider-adapter-spec.md)
(归一契约 / 流式事件 / 错误分类 / usage 归一 / 不变量 / 契约测试);
接入实务(端点 / 插头 / 代理 / 密钥)在 [technical-plan §5.1](../../docs/technical-plan.md)。

```text
src/
├─ contract.ts    归一契约临时占位(§6/§7 草案)——S2 收编入 @whispertavern/contracts 后删除
├─ fake/          脚本回放式内存 adapter(测试依赖,不出网;WP0.1 就位)
├─ openai/        S4'-a(openai-compat,含 DeepSeek reasoning_content 与本地端点)
├─ anthropic/     S4'-b(thinking 签名块回传 PV8)
├─ gemini/        S4'-c(SAFETY → CONTENT_FILTERED)
└─ local/         本地端点复用 openai-compat,预留差异化配置
```

依赖方向:runtime → **adapters** → contracts;adapters 不反向依赖 runtime / core 内部。
