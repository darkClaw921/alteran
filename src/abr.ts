import { buildTasksCommand } from './tracker/cli.js';

await buildTasksCommand('abr').parseAsync(process.argv);
