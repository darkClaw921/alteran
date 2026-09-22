/** Token estimate of each system-prompt block for the current project. */
import { Runtime } from '../src/core/runtime.js';
import { systemSections } from '../src/core/prompt.js';
import { estimateTokens } from '../src/core/context.js';

const rt = await Runtime.create({ cwd: process.cwd(), noMcp: true, model: 'ollama:test' });
const s = systemSections(rt.ext, rt.envInfo(rt.model));
for (const [k, v] of Object.entries(s)) console.log(k.padEnd(14), String(estimateTokens(v)).padStart(6), 'tokens');
console.log('total'.padEnd(14), String(estimateTokens(rt.main.system)).padStart(6), 'tokens');
await rt.shutdown();
process.exit(0);
