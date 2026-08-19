/**
 * Turning a painted SVG into a PNG.
 *
 * The napi build of resvg is fast and needs no subprocess, but native
 * prebuilds are exactly the sort of thing that misbehaves in an unusual
 * environment. The interface is therefore small enough that the `resvg` CLI
 * from nixpkgs can stand in, and Conquest picks whichever works at startup.
 */
import {execFile} from 'node:child_process';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';

const run = promisify(execFile);

/** Renders SVG source to PNG bytes. */
export interface Rasterizer {
  /** Name of the backend, for the startup log. */
  readonly name: string;
  render(svg: string, width: number): Promise<Buffer>;
}

/** The in-process renderer: no subprocess, no temporary files. */
export async function nativeRasterizer(): Promise<Rasterizer | undefined> {
  try {
    const {Resvg} = await import('@resvg/resvg-js');
    // Prove the binding actually renders before committing to it: importing
    // a native module can succeed and still fail on first use.
    const probe = new Resvg(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1" width="1" height="1"><rect width="1" height="1"/></svg>',
    );
    probe.render().asPng();

    return {
      name: '@resvg/resvg-js',
      async render(svg: string, width: number): Promise<Buffer> {
        const image = new Resvg(svg, {fitTo: {mode: 'width', value: width}});
        return Buffer.from(image.render().asPng());
      },
    };
  } catch {
    return undefined;
  }
}

/** The nixpkgs `resvg` command, used when the native binding will not load. */
export async function cliRasterizer(
  command = 'resvg',
): Promise<Rasterizer | undefined> {
  try {
    await run(command, ['--version']);
  } catch {
    return undefined;
  }

  return {
    name: `${command} (CLI)`,
    async render(svg: string, width: number): Promise<Buffer> {
      const directory = await mkdtemp(join(tmpdir(), 'conquest-map-'));
      const input = join(directory, 'map.svg');
      const output = join(directory, 'map.png');
      try {
        await writeFile(input, svg, 'utf8');
        await run(command, ['--width', String(width), input, output]);
        return await readFile(output);
      } finally {
        await rm(directory, {recursive: true, force: true});
      }
    },
  };
}

/**
 * Picks a rasterizer, preferring the in-process one.
 *
 * @returns undefined when neither backend is available, which is a working
 *   state: `/map` falls back to its text standings rather than failing.
 */
export async function selectRasterizer(): Promise<Rasterizer | undefined> {
  return (await nativeRasterizer()) ?? (await cliRasterizer());
}
