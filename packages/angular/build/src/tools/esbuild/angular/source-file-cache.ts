/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import { platform } from 'node:os';
import * as path from 'node:path';
import type ts from 'typescript';
import { MemoryLoadResultCache } from '../load-result-cache';

const USING_WINDOWS = platform() === 'win32';
const WINDOWS_SEP_REGEXP = new RegExp(`\\${path.win32.sep}`, 'g');

export class SourceFileCache extends Map<string, ts.SourceFile> {
  readonly modifiedFiles = new Set<string>();
  readonly typeScriptFileCache = new Map<string, string | Uint8Array>();
  readonly loadResultCache = new MemoryLoadResultCache();

  referencedFiles?: readonly string[];

  constructor(readonly persistentCachePath?: string) {
    super();
  }

  invalidate(files: Iterable<string>): void {
    if (files !== this.modifiedFiles) {
      this.modifiedFiles.clear();
    }
    for (let file of files) {
      file = path.normalize(file);
      this.loadResultCache.invalidate(file);

      // Normalize separators to allow matching TypeScript Host paths
      if (USING_WINDOWS) {
        file = file.replace(WINDOWS_SEP_REGEXP, path.posix.sep);
      }

      this.delete(file);
      this.modifiedFiles.add(file);
    }
  }
}
