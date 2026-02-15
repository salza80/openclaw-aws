// API Provider options
export const API_PROVIDERS = [
  {
    title: 'Anthropic (Claude)',
    value: 'anthropic-api-key',
    description: 'Official Anthropic API (claude.ai)',
  },
  {
    title: 'OpenRouter',
    value: 'openrouter-api-key',
    description: 'Multi-provider API (100+ models)',
  },
  { title: 'OpenAI (GPT)', value: 'openai-api-key', description: 'Official OpenAI API' },
  {
    title: 'Gemini (Google)',
    value: 'gemini-api-key',
    description: 'Official Google API for Gemini models',
  },
  { title: 'AI Gateway', value: 'ai-gateway-api-key', description: 'AI Gateway API' },
  {
    title: 'Cloudflare AI Gateway',
    value: 'cloudflare-ai-gateway-api-key',
    description: 'Cloudflare AI Gateway API',
  },
  { title: 'Moonshot', value: 'moonshot-api-key', description: 'Moonshot API' },
  { title: 'Kimi Code', value: 'kimi-code-api-key', description: 'Kimi Code API' },
  { title: 'Synthetic', value: 'synthetic-api-key', description: 'Synthetic API' },
  { title: 'Venice', value: 'venice-api-key', description: 'Venice API' },
  { title: 'Zai', value: 'zai-api-key', description: 'Zai API' },
  { title: 'Xiaomi', value: 'xiaomi-api-key', description: 'Xiaomi API' },
  { title: 'XAI', value: 'xai-api-key', description: 'XAI API' },
  { title: 'Minimax', value: 'minimax-api-key', description: 'Minimax API' },
  { title: 'Opencode Zen', value: 'opencode-zen-api-key', description: 'Opencode Zen API' },
] as const;

// Minimum supported Node.js major version
export const MIN_NODE_VERSION = 20;
