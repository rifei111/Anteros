/**
 * 模型服务预设：把常见 OpenAI 兼容服务商的地址与默认模型列出来，
 * 让用户不用记 Base URL、也不用抄文档。全部是「OpenAI 兼容」形态——
 * 本应用的模型调用只有一种协议，换服务商只换地址与模型名。
 *
 * 说明：这里只是界面用的静态清单，不含任何凭据；密钥永远只从本机加密库读。
 */
export interface LlmPreset {
  id: string;
  label: string;
  /** OpenAI 兼容的根地址（一般以 /v1 结尾；不要带 /chat/completions） */
  baseUrl: string;
  /** 该服务商的默认模型名，留空表示让用户自己填 */
  model: string;
  /** 申请密钥的地方，界面给个链接，不自动打开 */
  consoleUrl?: string;
  /** 一句话提示（例如本机服务不需要真密钥） */
  note?: string;
}

export const LLM_PRESETS: LlmPreset[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    consoleUrl: "https://platform.deepseek.com/api_keys",
  },
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    consoleUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "moonshot",
    label: "Moonshot（Kimi）",
    baseUrl: "https://api.moonshot.cn/v1",
    model: "moonshot-v1-8k",
    consoleUrl: "https://platform.moonshot.cn/console/api-keys",
  },
  {
    id: "zhipu",
    label: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-4-flash",
    consoleUrl: "https://bigmodel.cn/usercenter/apikeys",
  },
  {
    id: "qwen",
    label: "通义千问（兼容模式）",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-plus",
    consoleUrl: "https://bailian.console.aliyun.com/?apiKey=1",
  },
  {
    id: "siliconflow",
    label: "硅基流动",
    baseUrl: "https://api.siliconflow.cn/v1",
    model: "deepseek-ai/DeepSeek-V3",
    consoleUrl: "https://cloud.siliconflow.cn/account/ak",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "deepseek/deepseek-chat",
    consoleUrl: "https://openrouter.ai/keys",
  },
  {
    id: "ollama",
    label: "本机 Ollama / LM Studio",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "qwen2.5:7b",
    note: "本机服务通常不校验密钥，随便填一个占位值即可。",
  },
  {
    id: "custom",
    label: "自定义 OpenAI 兼容",
    baseUrl: "",
    model: "",
    note: "任何兼容 /chat/completions 的服务都可以，填根地址与模型名。",
  },
];

export function findPreset(id: string): LlmPreset | undefined {
  return LLM_PRESETS.find((preset) => preset.id === id);
}
