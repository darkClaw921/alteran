import fs from 'node:fs';
import { Command, Option } from 'commander';
import { packageRoot, projectRoot } from './config/paths.js';
import { loadSettings, type PermissionMode } from './config/settings.js';
import { buildTasksCommand } from './tracker/cli.js';
import { mark, paint, section, setColorEnabled } from './util/color.js';

// Providers, MCP and the agent runtime are imported where they are used: loading them up front
// costs a few hundred milliseconds before the boot animation could even start.

const version = JSON.parse(fs.readFileSync(`${packageRoot()}/package.json`, 'utf8')).version as string;

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - s.length));

const program = new Command('alteran')
  .description('alteran — coding agent terminal with a built-in phased task tracker')
  .version(version, '-v, --version')
  .argument('[prompt...]', 'Initial prompt')
  .option('-p, --print', 'Headless: run the prompt, print the answer and exit')
  .option('--json', 'Headless: stream events as JSON lines')
  .option('-m, --model <model>', 'Model as provider:model (anthropic:claude-opus-5, polza:deepseek/deepseek-v4.1-flash, …)')
  .addOption(new Option('--mode <mode>', 'Permission mode').choices(['default', 'acceptEdits', 'plan', 'autonomous']))
  .option('--dangerously-skip-permissions', 'Same as --mode autonomous')
  .addOption(new Option('--reasoning <level>', 'Reasoning effort').choices(['off', 'low', 'medium', 'high']))
  .option('-c, --continue', 'Continue the most recent session in this project')
  .option('-r, --resume [id]', 'Resume a session (id prefix, or pick interactively)')
  .option('--no-mcp', 'Do not connect MCP servers')
  .option('--no-color', 'Disable coloured output')
  .option('--verbose', 'Verbose headless output')
  .hook('preAction', (cmd) => {
    if (cmd.opts().color === false) setColorEnabled(false);
  })
  .action(async (promptParts: string[], o) => {
    const cwd = process.cwd();
    let prompt = promptParts.join(' ');
    const mode: PermissionMode | undefined = o.dangerouslySkipPermissions ? 'autonomous' : o.mode;
    const resume = o.continue ? 'last' : typeof o.resume === 'string' ? o.resume : undefined;
    if (o.print || o.json || !process.stdout.isTTY) {
      const piped = await readStdin();
      if (piped) prompt = prompt ? `${prompt}\n\n${piped}` : piped;
      if (!prompt.trim()) {
        console.error(paint.red('No prompt given.') + ' Usage: alteran -p "your task"');
        process.exit(1);
      }
      const { runHeadless } = await import('./headless.js');
      const code = await runHeadless({ prompt, cwd, model: o.model, mode, reasoning: o.reasoning, resume, json: o.json, mcp: o.mcp, verbose: o.verbose });
      process.exit(code);
    }
    // Get the gate dialing first; the interface and the agent load behind it.
    const { startIntro } = await import('./tui/intro.js');
    const intro = startIntro(cwd);
    const { startTui } = await import('./tui/app.js');
    await startTui({ cwd, prompt, model: o.model, mode, reasoning: o.reasoning, resume, pickResume: o.resume === true, mcp: o.mcp, intro });
  });

program.addCommand(buildTasksCommand('tasks'));

program
  .command('mcp')
  .description('List configured MCP servers (from alteran, Claude Code, Codex, Cursor, Gemini, plugins)')
  .argument('[action]', 'list | test', 'list')
  .action(async (action: string) => {
    const { loadExtensions } = await import('./compat/loader.js');
    const { McpManager } = await import('./mcp/manager.js');
    const cwd = process.cwd();
    const root = projectRoot(cwd);
    const ext = loadExtensions({ cwd, root, settings: loadSettings(cwd).settings });
    if (action === 'test') {
      console.log(section('MCP CONNECTION TEST', 80));
      const mgr = new McpManager(ext.mcpServers.values(), cwd);
      await mgr.connectAll();
      for (const s of mgr.servers.values()) {
        const badge = s.status === 'connected' ? mark.on() : s.status === 'needs-auth' ? mark.partial() : mark.bad();
        const status = s.status === 'connected' ? paint.green(pad(s.status, 12)) : paint.red(pad(s.status, 12));
        console.log(`${badge} ${paint.cyan(pad(s.def.name, 30))} ${status} ${paint.muted(`${s.tools.length} tools`)} ${paint.dim(s.error ?? '')}`);
      }
      await mgr.closeAll();
      process.exit(0);
    }
    console.log(section('MCP SERVERS', 80));
    for (const s of ext.mcpServers.values()) {
      const target = s.config.url ?? [s.config.command, ...(s.config.args ?? [])].join(' ');
      console.log(`${paint.cyan(pad(s.name, 34))} ${paint.muted(pad(String(s.origin), 22))} ${paint.dim(target)}`);
    }
  });

for (const kind of ['skills', 'agents', 'plugins', 'commands'] as const) {
  program
    .command(kind)
    .description(`List ${kind} discovered from all ecosystems`)
    .action(async () => {
      const { loadExtensions } = await import('./compat/loader.js');
      const cwd = process.cwd();
      const ext = loadExtensions({ cwd, root: projectRoot(cwd), settings: loadSettings(cwd).settings });
      console.log(section(kind.toUpperCase(), 80));
      const row = (name: string, origin: string, rest: string) =>
        console.log(`${paint.gold(pad(name, 38))} ${paint.muted(pad(origin, 22))} ${paint.dim(rest.replace(/\s+/g, ' ').slice(0, 80))}`);
      if (kind === 'plugins') for (const p of ext.plugins) row(p.key, p.origin, `${p.version ?? ''} ${p.root}`);
      if (kind === 'skills') for (const s of ext.skills.values()) row(s.name, String(s.origin), s.description);
      if (kind === 'agents') for (const a of ext.agents.values()) row(a.name, String(a.origin), a.description);
      if (kind === 'commands') for (const c of ext.commands.values()) row(`/${c.name}`, String(c.origin), c.description ?? '');
    });
}

program
  .command('sessions')
  .description('List saved sessions for this project')
  .action(async () => {
    const { SessionStore } = await import('./core/session.js');
    const root = projectRoot(process.cwd());
    const list = SessionStore.list(root);
    if (!list.length) return console.log(paint.muted('No saved sessions for this project.'));
    console.log(section('SESSIONS', 80));
    for (const [i, s] of list.entries()) {
      console.log(
        `${i === 0 ? mark.on() : paint.dim('[ ]')} ${paint.cyan(s.id.slice(0, 8))}  ${paint.muted(s.updatedAt.toISOString().slice(0, 16).replace('T', ' '))}  ${paint.dim(String(s.messages).padStart(4) + ' msgs')}  ${s.title}`,
      );
      // Agents the session delegated to keep their own transcripts next to it.
      for (const a of SessionStore.agents(root, s.id)) {
        console.log(`    ${paint.dim('|')} ${paint.bronze(a.id)}  ${paint.dim(String(a.messages).padStart(4) + ' msgs')}  ${paint.muted(a.title)}`);
      }
    }
    console.log(
      paint.dim(`\nContinue the latest: `) + paint.bold('alteran --continue') + paint.dim('   pick one: ') + paint.bold('alteran --resume') + paint.dim('   by id: ') + paint.bold(`alteran --resume ${list[0].id.slice(0, 8)}`),
    );
  });

program
  .command('models')
  .description('List a provider catalog with prices, or the providers serving one model')
  .argument('[provider]', 'provider id (default: the provider of the current model)')
  .argument('[filter...]', 'substring filter over model id and name')
  .option('--routes <model>', 'show the upstream providers and prices for one model')
  .option('--refresh', 'bypass the cached catalog')
  .action(async (providerArg: string | undefined, filterWords: string[], o: { routes?: string; refresh?: boolean }) => {
    const { ModelCatalog, filterModels, fmtContext, fmtMoney, fmtPrice } = await import('./providers/catalog.js');
    const { ProviderRegistry } = await import('./providers/registry.js');
    const cwd = process.cwd();
    const { settings } = loadSettings(cwd);
    const reg = new ProviderRegistry(settings);
    const catalog = new ModelCatalog(reg);
    const current = reg.resolve();
    const provider = providerArg && reg.configs[providerArg] ? providerArg : current.provider;
    // A first word that is not a provider id is part of the filter ("alteran models deepseek").
    const filter = [...(providerArg && !reg.configs[providerArg] ? [providerArg] : []), ...filterWords].join(' ');

    try {
      if (o.routes) {
        const routes = await catalog.routes(provider, o.routes, o.refresh);
        console.log(section(`${provider.toUpperCase()} / ${o.routes}`, 78));
        if (!routes.length) {
          console.log(paint.dim('This provider does not expose upstream routing for that model.'));
          return;
        }
        const pinned = reg.route({ provider, model: o.routes, id: `${provider}:${o.routes}` });
        for (const r of routes) {
          const here = pinned?.[0] === r.name;
          console.log(
            `${here ? mark.on() : paint.dim('[ ]')} ${paint.cyan(r.name.padEnd(26))} ${paint.muted(fmtContext(r.contextWindow).padStart(5))}  ${paint.gold(fmtPrice(r.pricing))}` +
              (r.ru ? paint.green('  data-in-RU') : '') + (r.moderated ? paint.amber('  moderated') : ''),
          );
        }
        console.log(paint.dim(`\nPin with: /model ${provider}:${o.routes}@<provider>[,<fallback>…]  (or @auto to unpin)`));
        return;
      }
      const all = await catalog.models(provider, o.refresh);
      const models = filterModels(all, filter);
      console.log(section(`${provider.toUpperCase()} — ${models.length} models (per 1M in / out)`, 78));
      for (const m of models) {
        const here = `${provider}:${m.id}` === current.id;
        const price = m.pricing ? `${fmtMoney(m.pricing.in, m.pricing.currency)} / ${fmtMoney(m.pricing.out, m.pricing.currency)}` : '—';
        console.log(`${here ? mark.on() : paint.dim('[ ]')} ${paint.cyan(m.id.padEnd(44))} ${paint.muted(fmtContext(m.contextWindow).padStart(5))}  ${paint.gold(price)}`);
      }
      if (!models.length) console.log(paint.dim('Nothing matches that filter.'));
    } catch (e) {
      console.log(`${mark.bad()} ${paint.red((e as Error).message)}`);
      process.exitCode = 1;
    }
  });

program
  .command('doctor')
  .description('Check configuration, providers, tracker and integrations')
  .action(async () => {
    const { loadExtensions } = await import('./compat/loader.js');
    const { ModelCatalog, fmtMoney } = await import('./providers/catalog.js');
    const { ProviderRegistry } = await import('./providers/registry.js');
    const { TrackerStore } = await import('./tracker/store.js');
    const cwd = process.cwd();
    const root = projectRoot(cwd);
    const { settings, errors } = loadSettings(cwd);
    const reg = new ProviderRegistry(settings);
    const ext = loadExtensions({ cwd, root, settings });

    console.log(`${paint.title('alteran')} ${paint.gold(version)}   ${paint.muted(`node ${process.version}`)}`);
    console.log(`${paint.muted('project root:')} ${paint.text(root)}`);
    for (const e of errors) console.log(`${mark.bad()} ${paint.red('settings:')} ${e}`);

    console.log('\n' + section('PROVIDERS', 66));
    for (const id of Object.keys(reg.configs)) {
      const cfg = reg.configs[id];
      const has = Boolean(reg.apiKey(id)) || !cfg.apiKeyEnv;
      const key = cfg.apiKeyEnv ?? '(no key needed)';
      console.log(`${has ? mark.on() : mark.off()} ${paint.cyan(pad(id, 16))} ${paint.muted(pad(cfg.type, 14))} ${has ? paint.green(key) : paint.dim(key)}`);
    }

    console.log('\n' + section('MODEL', 66));
    try {
      const ref = reg.resolve();
      const info = reg.info(ref);
      const route = reg.route(ref);
      console.log(`${paint.muted('default:')} ${paint.gold(ref.id)}   ${paint.muted(`context ${Math.round(info.contextWindow / 1000)}k, max output ${Math.round(info.maxOutput / 1000)}k`)}`);
      if (route) console.log(`${paint.muted('route:  ')} ${paint.cyan(route.join(', '))}`);
      const key = await new ModelCatalog(reg).key(ref.provider, true);
      if (key) {
        const balance = key.balance ?? key.remaining;
        console.log(
          `${paint.muted('key:    ')} ${paint.green(fmtMoney(balance, key.currency))}` +
            (key.limit ? paint.dim(` of ${fmtMoney(key.limit, key.currency)} (${key.reset ?? 'limit'})`) : '') +
            (key.used != null ? paint.muted(`   used ${fmtMoney(key.used, key.currency)}`) : ''),
        );
      }
    } catch (e) {
      console.log(`${mark.bad()} ${paint.red((e as Error).message)}`);
    }

    console.log('\n' + section('TRACKER', 66));
    const store = TrackerStore.discover(cwd);
    if (store) {
      const s = store.stats();
      console.log(`${mark.on()} ${paint.text(store.jsonlPath)}`);
      console.log(
        `    ${paint.muted('issues')} ${paint.bold(String(s.total))}   ${paint.muted('ready')} ${paint.green(String(s.ready))}   ${paint.muted('blocked')} ${paint.red(String(s.blocked))}   ${paint.muted('prefix')} ${paint.cyan(store.prefix + '-*')}`,
      );
    } else {
      console.log(`${mark.off()} ${paint.muted('not initialized')} ${paint.dim('(alteran tasks init)')}`);
    }

    console.log('\n' + section('EXTENSIONS', 66));
    const counts: Array<[string, number]> = [
      ['agents', ext.agents.size],
      ['commands', ext.commands.size],
      ['skills', ext.skills.size],
      ['plugins', ext.plugins.length],
      ['MCP servers', ext.mcpServers.size],
      ['hook sources', ext.hookSources.length],
    ];
    for (const [name, n] of counts) {
      console.log(`${n ? mark.on() : mark.off()} ${paint.cyan(pad(name, 14))} ${n ? paint.bold(String(n)) : paint.dim('0')}`);
    }
    console.log(
      `${paint.muted('permission rules:')} ${paint.green(`${ext.rules.allow.length} allow`)}  ${paint.red(`${ext.rules.deny.length} deny`)}  ${paint.amber(`${ext.rules.ask.length} ask`)}`,
    );
    console.log(`${paint.muted('instructions:')} ${ext.instructions.length ? paint.text(ext.instructions.map((i) => i.file).join(', ')) : paint.dim('(none)')}`);
    for (const w of ext.warnings) console.log(`${mark.bad()} ${paint.amber(w)}`);
  });

program.parseAsync(process.argv).catch((e) => {
  console.error(paint.red(e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
