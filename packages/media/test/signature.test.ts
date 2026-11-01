import { describe, it, expect } from 'vitest';
import { detectFileKind } from '../src/signature';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

async function tmp(bytes: number[]) {
  const d = await mkdtemp(`${tmpdir()}/sig-`);
  const p = `${d}/f.bin`;
  await writeFile(p, Buffer.from(bytes));
  return p;
}

describe('file signature detection', () => {
  it('detects mp4 ftyp', async () => {
    expect(await detectFileKind(await tmp([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32, ...Array(4).fill(0)]))).toBe('mp4');
  });
  it('detects png and jpg', async () => {
    expect(await detectFileKind(await tmp([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]))).toBe('png');
    expect(await detectFileKind(await tmp([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe('jpg');
  });
  it('rejects disguised files as unknown', async () => {
    expect(await detectFileKind(await tmp([0x00, 0x01, 0x02, 0xfe, 0xff, 0x80, 0x81, 0x82, 0x83, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]))).toBe('unknown');
  });
});
