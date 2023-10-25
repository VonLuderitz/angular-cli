/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import { readFile } from 'node:fs/promises';
import { extname, posix } from 'node:path';
import Piscina from 'piscina';
import { BuildOutputFile, BuildOutputFileType } from '../../tools/esbuild/bundler-context';
import { BuildOutputAsset } from '../../tools/esbuild/bundler-execution-result';
import { getESMLoaderArgs } from './esm-in-memory-loader/node-18-utils';
import { startServer } from './prerender-server';
import type { RenderResult, ServerContext } from './render-page';
import type { RenderWorkerData } from './render-worker';
import type {
  RoutersExtractorWorkerResult,
  RoutesExtractorWorkerData,
} from './routes-extractor-worker';

interface PrerenderOptions {
  routesFile?: string;
  discoverRoutes?: boolean;
}

interface AppShellOptions {
  route?: string;
}

export async function prerenderPages(
  workspaceRoot: string,
  appShellOptions: AppShellOptions = {},
  prerenderOptions: PrerenderOptions = {},
  outputFiles: Readonly<BuildOutputFile[]>,
  assets: Readonly<BuildOutputAsset[]>,
  document: string,
  sourcemap = false,
  inlineCriticalCss = false,
  maxThreads = 1,
  verbose = false,
): Promise<{
  output: Record<string, string>;
  warnings: string[];
  errors: string[];
  prerenderedRoutes: Set<string>;
}> {
  const outputFilesForWorker: Record<string, string> = {};
  const serverBundlesSourceMaps = new Map<string, string>();
  const warnings: string[] = [];
  const errors: string[] = [];

  for (const { text, path, type } of outputFiles) {
    const fileExt = extname(path);
    if (type === BuildOutputFileType.Server && fileExt === '.map') {
      serverBundlesSourceMaps.set(path.slice(0, -4), text);
    } else if (
      type === BuildOutputFileType.Server || // Contains the server runnable application code
      (type === BuildOutputFileType.Browser && fileExt === '.css') // Global styles for critical CSS inlining.
    ) {
      outputFilesForWorker[path] = text;
    }
  }

  // Inline sourcemap into JS file. This is needed to make Node.js resolve sourcemaps
  // when using `--enable-source-maps` when using in memory files.
  for (const [filePath, map] of serverBundlesSourceMaps) {
    const jsContent = outputFilesForWorker[filePath];
    if (jsContent) {
      outputFilesForWorker[filePath] =
        jsContent +
        `\n//# sourceMappingURL=` +
        `data:application/json;base64,${Buffer.from(map).toString('base64')}`;
    }
  }
  serverBundlesSourceMaps.clear();

  // Start server to handle HTTP requests to assets.
  // TODO: consider starting this is a seperate process to avoid any blocks to the main thread.
  const { address: assetsServerAddress, close: closeAssetsServer } = await startServer(assets);

  try {
    // Get routes to prerender
    const { routes: allRoutes, warnings: routesWarnings } = await getAllRoutes(
      workspaceRoot,
      outputFilesForWorker,
      document,
      appShellOptions,
      prerenderOptions,
      sourcemap,
      verbose,
      assetsServerAddress,
    );

    if (routesWarnings?.length) {
      warnings.push(...routesWarnings);
    }

    if (allRoutes.size < 1) {
      return {
        errors,
        warnings,
        output: {},
        prerenderedRoutes: allRoutes,
      };
    }

    // Render routes
    const {
      warnings: renderingWarnings,
      errors: renderingErrors,
      output,
    } = await renderPages(
      sourcemap,
      allRoutes,
      maxThreads,
      workspaceRoot,
      outputFilesForWorker,
      inlineCriticalCss,
      document,
      assetsServerAddress,
      appShellOptions,
    );

    errors.push(...renderingErrors);
    warnings.push(...renderingWarnings);

    return {
      errors,
      warnings,
      output,
      prerenderedRoutes: allRoutes,
    };
  } finally {
    void closeAssetsServer?.();
  }
}

class RoutesSet extends Set<string> {
  override add(value: string): this {
    return super.add(addLeadingSlash(value));
  }
}

async function renderPages(
  sourcemap: boolean,
  allRoutes: Set<string>,
  maxThreads: number,
  workspaceRoot: string,
  outputFilesForWorker: Record<string, string>,
  inlineCriticalCss: boolean,
  document: string,
  baseUrl: string,
  appShellOptions: AppShellOptions,
): Promise<{
  output: Record<string, string>;
  warnings: string[];
  errors: string[];
}> {
  const output: Record<string, string> = {};
  const warnings: string[] = [];
  const errors: string[] = [];

  const workerExecArgv = getESMLoaderArgs();
  if (sourcemap) {
    workerExecArgv.push('--enable-source-maps');
  }

  const renderWorker = new Piscina({
    filename: require.resolve('./render-worker'),
    maxThreads: Math.min(allRoutes.size, maxThreads),
    workerData: {
      workspaceRoot,
      outputFiles: outputFilesForWorker,
      inlineCriticalCss,
      document,
      baseUrl,
    } as RenderWorkerData,
    execArgv: workerExecArgv,
  });

  try {
    const renderingPromises: Promise<void>[] = [];
    const appShellRoute = appShellOptions.route && addLeadingSlash(appShellOptions.route);

    for (const route of allRoutes) {
      const isAppShellRoute = appShellRoute === route;
      const serverContext: ServerContext = isAppShellRoute ? 'app-shell' : 'ssg';
      const render: Promise<RenderResult> = renderWorker.run({ route, serverContext });
      const renderResult: Promise<void> = render.then(({ content, warnings, errors }) => {
        if (content !== undefined) {
          const outPath = isAppShellRoute
            ? 'index.html'
            : posix.join(removeLeadingSlash(route), 'index.html');
          output[outPath] = content;
        }

        if (warnings) {
          warnings.push(...warnings);
        }

        if (errors) {
          errors.push(...errors);
        }
      });

      renderingPromises.push(renderResult);
    }

    await Promise.all(renderingPromises);
  } finally {
    // Workaround piscina bug where a worker thread will be recreated after destroy to meet the minimum.
    renderWorker.options.minThreads = 0;
    void renderWorker.destroy();
  }

  return {
    errors,
    warnings,
    output,
  };
}

async function getAllRoutes(
  workspaceRoot: string,
  outputFilesForWorker: Record<string, string>,
  document: string,
  appShellOptions: AppShellOptions,
  prerenderOptions: PrerenderOptions,
  sourcemap: boolean,
  verbose: boolean,
  assetsServerAddress: string,
): Promise<{ routes: Set<string>; warnings?: string[] }> {
  const { routesFile, discoverRoutes } = prerenderOptions;
  const routes = new RoutesSet();
  const { route: appShellRoute } = appShellOptions;

  if (appShellRoute !== undefined) {
    routes.add(appShellRoute);
  }

  if (routesFile) {
    const routesFromFile = (await readFile(routesFile, 'utf8')).split(/\r?\n/);
    for (const route of routesFromFile) {
      routes.add(route.trim());
    }
  }

  if (!discoverRoutes) {
    return { routes };
  }

  const workerExecArgv = getESMLoaderArgs();
  if (sourcemap) {
    workerExecArgv.push('--enable-source-maps');
  }

  const renderWorker = new Piscina({
    filename: require.resolve('./routes-extractor-worker'),
    maxThreads: 1,
    workerData: {
      workspaceRoot,
      outputFiles: outputFilesForWorker,
      document,
      verbose,
      url: assetsServerAddress,
    } as RoutesExtractorWorkerData,
    execArgv: workerExecArgv,
  });

  const { routes: extractedRoutes, warnings }: RoutersExtractorWorkerResult = await renderWorker
    .run({})
    .finally(() => {
      // Workaround piscina bug where a worker thread will be recreated after destroy to meet the minimum.
      renderWorker.options.minThreads = 0;
      void renderWorker.destroy();
    });

  for (const route of extractedRoutes) {
    routes.add(route);
  }

  return { routes, warnings };
}

function addLeadingSlash(value: string): string {
  return value.charAt(0) === '/' ? value : '/' + value;
}

function removeLeadingSlash(value: string): string {
  return value.charAt(0) === '/' ? value.slice(1) : value;
}
