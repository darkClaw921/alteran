import React from 'react';
import { Box, renderToString } from 'ink';
import { Runtime } from '../src/core/runtime.js';
import { UiStore } from '../src/tui/store.js';
import { GatePanel } from '../src/tui/components/GatePanel.js';
import { SystemsPanel } from '../src/tui/components/SystemsPanel.js';
import { StreamView, StatusLine } from '../src/tui/components/Console.js';
import { InputBox } from '../src/tui/components/InputBox.js';
import { C } from '../src/tui/theme.js';

const rt = await Runtime.create({ cwd: process.cwd(), noMcp: true, mode: 'acceptEdits' });
const store = new UiStore(rt);
store.running = true; store.runStartedAt = Date.now() - 33000; store.contextTokens = 148000; store.contextWindow = 200000; store.runTokens = 12400;
for (const [k,v] of [['ctx','done'],['plan','done'],['read','done'],['patch','done'],['typecheck','done'],['tests','done'],['lint','done'],['review','active']] as const) { const s = store.stages.get(k as any); s.state = v as any; s.ms = 1900 + Math.random()*5000; }
store.stages.files.read = new Set(['a','b','c','d']); store.stages.files.patched = new Set(['a','b']); store.stages.tests = { passed: 42, total: 42, failed: 0, coverage: 81 };
store.samples = Array.from({length: 40}, (_,i) => [Date.now() - (39-i)*60000, Math.round(2000 + 9000*Math.random()*(i/40))] as [number,number]);
store.log('self-review started', C.cyan); store.log('lint 2 warnings', C.amber); store.log('vitest 42 passed', C.green); store.log('typecheck ok', C.muted);
store.push({kind:'user', text:'add iris auth to the gate dialer, keep SG-1 tokens working', t: 0});
store.push({kind:'assistant', text:"I'll wire `iris.authorize()` into the dialer, keep the legacy SG-1 path behind a compat flag, and cover the error paths with tests.", t: 500});
store.push({kind:'tool', id:'1', agentId:'main', name:'Read', summary:'src/gate/dial.ts', input:{file_path:'src/gate/dial.ts'}, t:1000, status:'ok', display:{summary:'Read 142 lines'}});
store.push({kind:'tool', id:'2', agentId:'main', name:'Grep', summary:'pattern: "gate.open\\(", path: "src"', input:{}, t:3000, status:'ok', display:{summary:'Found 6 matches across 4 files'}});
store.push({kind:'tool', id:'3', agentId:'main', name:'TodoWrite', summary:'', input:{todos:[{content:'read gate + router modules',status:'completed'},{content:'add iris.authorize() guard',status:'completed'},{content:'write dial.test.ts for denied tokens',status:'in_progress'},{content:'typecheck + unit tests',status:'pending'}]}, t:4000, status:'ok', display:{summary:''}});
store.push({kind:'tool', id:'4', agentId:'main', name:'Edit', summary:'src/gate/dial.ts', input:{file_path:'src/gate/dial.ts'}, t:7000, status:'ok', display:{summary:'Updated src/gate/dial.ts with 42 additions and 8 removals', diff:[{kind:'del',lineNo:118,text:'const session = await gate.open(address)'},{kind:'add',lineNo:118,text:'const token = await iris.authorize(address, ctx.actor)'},{kind:'add',lineNo:119,text:'if (!token.ok) throw new IrisDenied(token.reason)'},{kind:'add',lineNo:120,text:'const session = await gate.open(address, token)'}]}});
store.push({kind:'tool', id:'5', agentId:'main', name:'Bash', summary:'pnpm vitest run src/gate', input:{command:'pnpm vitest run src/gate'}, t:15000, status:'ok', display:{summary:'Test Files 2 passed (2) Tests 42 passed (42)', lines:['PASS src/gate/dial.test.ts 18 tests 1.9s','PASS src/gate/iris.test.ts 24 tests 2.4s','Test Files 2 passed (2)']}});
store.consilium = { title:'phase 2', note:'plan 4/6', source:'tracker', current:'alt-3f2.5: fix lint warnings', items:[
 {id:'1',mark:'[x]',color:C.green,title:'read gate + router modules'},{id:'2',mark:'[x]',color:C.green,title:'add iris.authorize() guard'},{id:'3',mark:'[x]',color:C.green,title:'write dial.test.ts (18)'},{id:'4',mark:'[x]',color:C.green,title:'typecheck + unit tests'},{id:'5',mark:'[/]',color:C.amber,title:'fix 2 lint warnings'},{id:'6',mark:'[ ]',color:C.muted,title:'commit + open PR #412'}]};
const H = 44, W = 200;
const out = renderToString(
  <Box flexDirection="row" width={W} height={H}>
    <GatePanel store={store} width={46} height={H} />
    <Box flexDirection="column" flexGrow={1} paddingX={2} height={H} backgroundColor={C.bg}>
      <StreamView store={store} width={W-46-50-4} height={H-6} scroll={0} />
      <StatusLine store={store} width={W-46-50-4} />
      <InputBox value={'fix the lint warnings, then commit and open the PR'} cursor={49} width={W-46-50-4} queued={0} mode={'acceptEdits'} />
    </Box>
    <SystemsPanel store={store} rt={rt} width={50} height={H} />
  </Box>, { columns: W }
);
console.log(out);
process.exit(0);
