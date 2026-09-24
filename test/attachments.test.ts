import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeRuntime as scriptedRuntime, textTurn, useTempDirs } from './scripted.js';
import { runSlashCommand } from '../src/core/commands.js';
import { clipboardImage, describeImages, drainImages, imageRefs, loadImage } from '../src/core/attachments.js';
import type { Message } from '../src/types.js';

const dirs = useTempDirs('attachments');
const makeRuntime = () => scriptedRuntime(dirs, [textTurn('ok')]);
const dir = () => dirs.dir;

/** A one-pixel PNG: enough for anything that checks the magic bytes. */
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001', 'hex');

function image(rel: string, bytes = PNG) {
  const file = path.join(dir(), rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return file;
}

const imagesIn = (messages: Message[]) => messages.flatMap((m) => m.content.filter((b) => b.type === 'image'));
const textsIn = (messages: Message[]) => messages.flatMap((m) => m.content.filter((b) => b.type === 'text').map((b) => b.text));

describe('image attachments', () => {
  it('accepts an image and rejects anything else', () => {
    const good = image('a.png');
    expect('block' in loadImage(good)).toBe(true);
    expect(loadImage(path.join(dir(), 'missing.png'))).toEqual({ error: expect.stringContaining('No such file') });
    const text = path.join(dir(), 'notes.txt');
    fs.writeFileSync(text, 'hi');
    const notImage = loadImage(text);
    expect('error' in notImage ? notImage.error : '').toContain('is not an image');
    const huge = loadImage(image('huge.png', Buffer.alloc(6 * 1024 * 1024)));
    expect('error' in huge ? huge.error : '').toContain('limited to');
  });

  it('lifts @image mentions out of the text and leaves everything else alone', () => {
    image('shot.png');
    const { text, images } = imageRefs('look at @shot.png and @src/app.ts', dir());
    expect(images).toHaveLength(1);
    expect(text).toContain('[image attached: shot.png]');
    // A source file mention is not ours to rewrite.
    expect(text).toContain('@src/app.ts');
  });

  it('says so when a mentioned image will not load', () => {
    const { text, images } = imageRefs('see @nope.png', dir());
    expect(images).toHaveLength(1);
    expect(text).toContain('[image not attached:');
  });

  it('puts the image ahead of the text the model reads', async () => {
    image('shot.png');
    const { rt, provider } = await makeRuntime();
    await rt.main.send('what is wrong with @shot.png', new AbortController().signal);
    const messages = provider.requests.at(-1)!.messages;
    const images = imagesIn(messages);
    expect(images).toHaveLength(1);
    expect(images[0].type === 'image' && images[0].mediaType).toBe('image/png');
    // The text still says what the user said, with the mention marked as attached.
    expect(textsIn(messages).join('\n')).toContain('[image attached: shot.png]');
  });

  it('carries an attached file on the next message only', async () => {
    const file = image('queued.png');
    const { rt, provider } = await makeRuntime();
    const res = await runSlashCommand(rt, `/attach ${file}`);
    expect(res.kind).toBe('info');
    await rt.main.send('first', new AbortController().signal);
    expect(imagesIn(provider.requests.at(-1)!.messages)).toHaveLength(1);
    await rt.main.send('second', new AbortController().signal);
    // The queue is drained by the message it belonged to: the new one carries no image (the first
    // still does, further up the same history).
    const lastRequest = provider.requests.at(-1)!.messages;
    expect(imagesIn([lastRequest.at(-1)!])).toHaveLength(0);
    expect(textsIn([lastRequest.at(-1)!]).join('')).toContain('second');
  });

  it('refuses a bad path at the moment it is attached', async () => {
    const { rt } = await makeRuntime();
    expect((await runSlashCommand(rt, '/attach')).kind).toBe('error');
    expect((await runSlashCommand(rt, '/attach nope.png')).kind).toBe('error');
    expect(rt.pendingImages).toHaveLength(0);
  });

  it('keeps images away from subagent prompts', async () => {
    const { rt } = await makeRuntime();
    const sub = rt.agents.spawn({ agentType: 'general-purpose', description: 'x', prompt: 'look at @shot.png', parent: rt.main, signal: new AbortController().signal });
    await sub.turn;
    // The orchestrator's mention syntax must not be interpreted inside a delegated prompt.
    expect(imagesIn(sub.agent.messages)).toHaveLength(0);
  });

  it('drops images that no longer load and reports the size', () => {
    image('ok.png');
    const { blocks, errors } = drainImages([path.join(dir(), 'ok.png'), path.join(dir(), 'gone.png')]);
    expect(blocks).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(describeImages(blocks)).toMatch(/1 image attached/);
    expect(describeImages([])).toBeUndefined();
  });

  it('explains itself when the platform has no clipboard reader', () => {
    const got = clipboardImage({});
    // In CI there is no pngpaste/wl-paste/xclip with an image, so this is the hint path.
    expect('error' in got ? got.error : '').toMatch(/Pass a path instead|clipboard/);
  });
});
