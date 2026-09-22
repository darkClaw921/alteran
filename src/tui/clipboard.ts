import { spawn } from 'node:child_process';

/**
 * Copy text to the system clipboard without leaving the TUI.
 *
 * Mouse selection in a terminal is rectangular across the whole screen, so dragging over the
 * console also grabs the side panels; copying from here yields exactly the console text.
 * Falls back to OSC 52, which most terminals honour even over SSH.
 */
export function copyToClipboard(text: string, out: NodeJS.WriteStream = process.stdout): boolean {
  // ALTERAN_CLIPBOARD=osc52 skips the helper binaries (useful over SSH and in tests).
  if (process.env.ALTERAN_CLIPBOARD === 'osc52') return osc52(text, out);
  const cmd =
    process.platform === 'darwin'
      ? ['pbcopy']
      : process.platform === 'win32'
        ? ['clip']
        : process.env.WAYLAND_DISPLAY
          ? ['wl-copy']
          : ['xclip', '-selection', 'clipboard'];
  try {
    const child = spawn(cmd[0], cmd.slice(1), { stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', () => osc52(text, out));
    child.stdin.end(text);
    return true;
  } catch {
    return osc52(text, out);
  }
}

function osc52(text: string, out: NodeJS.WriteStream): boolean {
  try {
    out.write(`\u001b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\u0007`);
    return true;
  } catch {
    return false;
  }
}
