import { render, Text, useInput } from 'ink';
import { makeIo, sleep } from '../test/harness.js';

const seen: string[] = [];
function T() {
  useInput((ch, key) => {
    seen.push(
      JSON.stringify({
        ch,
        keys: Object.entries(key)
          .filter(([, v]) => v === true)
          .map(([k]) => k),
      }),
    );
  });
  return <Text>x</Text>;
}
const io = makeIo();
const inst = render(<T />, { stdin: io.stdin as NodeJS.ReadStream, stdout: io.stdout as NodeJS.WriteStream, patchConsole: false, exitOnCtrlC: false });
await sleep(200);
io.key('/he');
await sleep(100);
io.key('\r');
await sleep(100);
io.key('\t');
await sleep(100);
io.key('\u001b[15~');
await sleep(200);
console.error(seen.join('\n'));
inst.unmount();
process.exit(0);
