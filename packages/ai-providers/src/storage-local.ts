// Local filesystem StorageProvider adapter — for single-node/dev deployments and
// integration tests with REAL files (not mocks). Files served from a base dir;
// signedUrl returns a path under the API's /files route.
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { StorageProvider } from '@clipforge/core';

export class LocalFsStorageProvider implements StorageProvider {
  readonly id = 'local-fs';
  constructor(
    private baseDir: string,
    private publicPrefix = '/files',
  ) {}

  private p(key: string) {
    const safe = key.replace(/\.\./g, '').replace(/^\/+/, '');
    if (!safe) throw new Error('empty storage key');
    return `${this.baseDir}/${safe}`;
  }

  async put(key: string, filePath: string): Promise<string> {
    const dest = this.p(key);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(filePath, dest);
    return `${this.publicPrefix}/${key.replace(/^\//, '')}`;
  }
  async get(key: string, destPath: string): Promise<void> {
    await copyFile(this.p(key), destPath);
  }
  async signedUrl(key: string): Promise<string> {
    return `${this.publicPrefix}/${key.replace(/^\//, '')}`;
  }
  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.p(key));
      return true;
    } catch {
      return false;
    }
  }
}
