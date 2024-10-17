/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import { BuilderContext } from '@angular-devkit/architect';
import assert from 'node:assert';
import { SourceFileCache } from '../../tools/esbuild/angular/source-file-cache';
import { generateBudgetStats } from '../../tools/esbuild/budget-stats';
import { BuildOutputFileType, BundlerContext } from '../../tools/esbuild/bundler-context';
import { ExecutionResult, RebuildState } from '../../tools/esbuild/bundler-execution-result';
import { checkCommonJSModules } from '../../tools/esbuild/commonjs-checker';
import { extractLicenses } from '../../tools/esbuild/license-extractor';
import { profileAsync } from '../../tools/esbuild/profiling';
import {
  calculateEstimatedTransferSizes,
  logBuildStats,
  transformSupportedBrowsersToTargets,
} from '../../tools/esbuild/utils';
import { BudgetCalculatorResult, checkBudgets } from '../../utils/bundle-calculator';
import { shouldOptimizeChunks } from '../../utils/environment-options';
import { resolveAssets } from '../../utils/resolve-assets';
import {
  SERVER_APP_ENGINE_MANIFEST_FILENAME,
  generateAngularServerAppEngineManifest,
} from '../../utils/server-rendering/manifest';
import { getSupportedBrowsers } from '../../utils/supported-browsers';
import { optimizeChunks } from './chunk-optimizer';
import { executePostBundleSteps } from './execute-post-bundle';
import { inlineI18n, loadActiveTranslations } from './i18n';
import { NormalizedApplicationBuildOptions } from './options';
import { OutputMode } from './schema';
import { createComponentStyleBundler, setupBundlerContexts } from './setup-bundling';

// eslint-disable-next-line max-lines-per-function
export async function executeBuild(
  options: NormalizedApplicationBuildOptions,
  context: BuilderContext,
  rebuildState?: RebuildState,
): Promise<ExecutionResult> {
  const {
    projectRoot,
    workspaceRoot,
    i18nOptions,
    optimizationOptions,
    assets,
    outputMode,
    cacheOptions,
    serverEntryPoint,
    baseHref,
    ssrOptions,
    verbose,
    colors,
    jsonLogs,
  } = options;

  // TODO: Consider integrating into watch mode. Would require full rebuild on target changes.
  const browsers = getSupportedBrowsers(projectRoot, context.logger);

  // Load active translations if inlining
  // TODO: Integrate into watch mode and only load changed translations
  if (i18nOptions.shouldInline) {
    await loadActiveTranslations(context, i18nOptions);
  }

  // Reuse rebuild state or create new bundle contexts for code and global stylesheets
  let bundlerContexts;
  let componentStyleBundler;
  let codeBundleCache;
  if (rebuildState) {
    bundlerContexts = rebuildState.rebuildContexts;
    componentStyleBundler = rebuildState.componentStyleBundler;
    codeBundleCache = rebuildState.codeBundleCache;
  } else {
    const target = transformSupportedBrowsersToTargets(browsers);
    codeBundleCache = new SourceFileCache(cacheOptions.enabled ? cacheOptions.path : undefined);
    componentStyleBundler = createComponentStyleBundler(options, target);
    bundlerContexts = setupBundlerContexts(options, target, codeBundleCache, componentStyleBundler);
  }

  let bundlingResult = await BundlerContext.bundleAll(
    bundlerContexts,
    rebuildState?.fileChanges.all,
  );

  if (options.optimizationOptions.scripts && shouldOptimizeChunks) {
    bundlingResult = await profileAsync('OPTIMIZE_CHUNKS', () =>
      optimizeChunks(
        bundlingResult,
        options.sourcemapOptions.scripts ? !options.sourcemapOptions.hidden || 'hidden' : false,
      ),
    );
  }

  const executionResult = new ExecutionResult(
    bundlerContexts,
    componentStyleBundler,
    codeBundleCache,
  );
  executionResult.addWarnings(bundlingResult.warnings);

  // Return if the bundling has errors
  if (bundlingResult.errors) {
    executionResult.addErrors(bundlingResult.errors);

    return executionResult;
  }

  // Analyze external imports if external options are enabled
  if (options.externalPackages || bundlingResult.externalConfiguration) {
    const {
      externalConfiguration,
      externalImports: { browser, server },
    } = bundlingResult;
    const implicitBrowser = browser ? [...browser] : [];
    const implicitServer = server ? [...server] : [];
    // TODO: Implement wildcard externalConfiguration filtering
    executionResult.setExternalMetadata(
      externalConfiguration
        ? implicitBrowser.filter((value) => !externalConfiguration.includes(value))
        : implicitBrowser,
      externalConfiguration
        ? implicitServer.filter((value) => !externalConfiguration.includes(value))
        : implicitServer,
      externalConfiguration,
    );
  }

  const { metafile, initialFiles, outputFiles } = bundlingResult;

  executionResult.outputFiles.push(...outputFiles);

  const changedFiles =
    rebuildState && executionResult.findChangedFiles(rebuildState.previousOutputHashes);

  // Analyze files for bundle budget failures if present
  let budgetFailures: BudgetCalculatorResult[] | undefined;
  if (options.budgets) {
    const compatStats = generateBudgetStats(metafile, outputFiles, initialFiles);
    budgetFailures = [...checkBudgets(options.budgets, compatStats, true)];
    for (const { message, severity } of budgetFailures) {
      if (severity === 'error') {
        executionResult.addError(message);
      } else {
        executionResult.addWarning(message);
      }
    }
  }

  // Calculate estimated transfer size if scripts are optimized
  let estimatedTransferSizes;
  if (optimizationOptions.scripts || optimizationOptions.styles.minify) {
    estimatedTransferSizes = await calculateEstimatedTransferSizes(executionResult.outputFiles);
  }

  // Check metafile for CommonJS module usage if optimizing scripts
  if (optimizationOptions.scripts) {
    const messages = checkCommonJSModules(metafile, options.allowedCommonJsDependencies);
    executionResult.addWarnings(messages);
  }

  // Copy assets
  if (assets) {
    executionResult.addAssets(await resolveAssets(assets, workspaceRoot));
  }

  // Extract and write licenses for used packages
  if (options.extractLicenses) {
    executionResult.addOutputFile(
      '3rdpartylicenses.txt',
      await extractLicenses(metafile, workspaceRoot),
      BuildOutputFileType.Root,
    );
  }

  // Watch input index HTML file if configured
  if (options.indexHtmlOptions) {
    executionResult.extraWatchFiles.push(options.indexHtmlOptions.input);
    executionResult.htmlIndexPath = options.indexHtmlOptions.output;
    executionResult.htmlBaseHref = options.baseHref;
  }

  // Create server app engine manifest
  if (serverEntryPoint) {
    executionResult.addOutputFile(
      SERVER_APP_ENGINE_MANIFEST_FILENAME,
      generateAngularServerAppEngineManifest(i18nOptions, baseHref, undefined),
      BuildOutputFileType.ServerRoot,
    );
  }

  // Perform i18n translation inlining if enabled
  if (i18nOptions.shouldInline) {
    const result = await inlineI18n(options, executionResult, initialFiles);
    executionResult.addErrors(result.errors);
    executionResult.addWarnings(result.warnings);
    executionResult.addPrerenderedRoutes(result.prerenderedRoutes);
  } else {
    const result = await executePostBundleSteps(
      options,
      executionResult.outputFiles,
      executionResult.assetFiles,
      initialFiles,
      // Set lang attribute to the defined source locale if present
      i18nOptions.hasDefinedSourceLocale ? i18nOptions.sourceLocale : undefined,
    );

    executionResult.addErrors(result.errors);
    executionResult.addWarnings(result.warnings);
    executionResult.addPrerenderedRoutes(result.prerenderedRoutes);
    executionResult.outputFiles.push(...result.additionalOutputFiles);
    executionResult.assetFiles.push(...result.additionalAssets);
  }

  if (serverEntryPoint) {
    const prerenderedRoutes = executionResult.prerenderedRoutes;

    // Regenerate the manifest to append prerendered routes data. This is only needed if SSR is enabled.
    if (outputMode === OutputMode.Server && Object.keys(prerenderedRoutes).length) {
      const manifest = executionResult.outputFiles.find(
        (f) => f.path === SERVER_APP_ENGINE_MANIFEST_FILENAME,
      );
      assert(manifest, `${SERVER_APP_ENGINE_MANIFEST_FILENAME} was not found in output files.`);
      manifest.contents = new TextEncoder().encode(
        generateAngularServerAppEngineManifest(i18nOptions, baseHref, prerenderedRoutes),
      );
    }

    executionResult.addOutputFile(
      'prerendered-routes.json',
      JSON.stringify({ routes: prerenderedRoutes }, null, 2),
      BuildOutputFileType.Root,
    );
  }

  // Write metafile if stats option is enabled
  if (options.stats) {
    executionResult.addOutputFile(
      'stats.json',
      JSON.stringify(metafile, null, 2),
      BuildOutputFileType.Root,
    );
  }

  if (!jsonLogs) {
    executionResult.addLog(
      logBuildStats(
        metafile,
        outputFiles,
        initialFiles,
        budgetFailures,
        colors,
        changedFiles,
        estimatedTransferSizes,
        !!ssrOptions,
        verbose,
      ),
    );
  }

  return executionResult;
}
