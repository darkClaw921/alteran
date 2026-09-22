import { Runtime } from '../src/core/runtime.js';
import { systemSections } from '../src/core/prompt.js';

const rt = await Runtime.create({ cwd: process.cwd(), noMcp: true, model: 'ollama:test' });
const s = systemSections(rt.ext, rt.envInfo(rt.model), rt.promptCaps(rt.main));
console.log(s.agents + '\n\n' + s.skills + '\n\n' + s.env);
await rt.shutdown();
process.exit(0);
