import { OpenAICompatProvider } from '../src/providers/openai-compat.js';
import { ReadTool } from '../src/tools/fs-tools.js';
import { toolSpec } from '../src/tools/schema.js';

const p = new OpenAICompatProvider({
  id: 'polza',
  apiKey: process.env.POLZA_KEY,
  baseURL: 'https://polza.ai/api/v1',
  reasoningField: 'openrouter',
  anthropicCaching: true,
});
const t0 = Date.now();
for await (const ev of p.stream({
  model: 'deepseek/deepseek-v4.1-flash',
  system: 'You are a test agent. Use tools when asked.',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Прочитай файл package.json с помощью инструмента Read и скажи имя пакета.' }] }],
  tools: [toolSpec(ReadTool)],
  maxTokens: 2000,
  reasoning: process.env.NO_REASONING ? 'off' : 'high',
})) {
  if (ev.type === 'done') console.log(`${Date.now() - t0}ms stop=${ev.stopReason}`, JSON.stringify(ev.message.content).slice(0, 300), ev.usage);
  else if (ev.type === 'text_delta') process.stdout.write(ev.text);
}
