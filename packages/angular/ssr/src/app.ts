/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import { LOCALE_ID, StaticProvider, ɵresetCompiledComponents } from '@angular/core';
import { REQUEST, REQUEST_CONTEXT, RESPONSE_INIT } from '@angular/ssr/tokens';
import { ServerAssets } from './assets';
import { Hooks } from './hooks';
import { getAngularAppManifest } from './manifest';
import { RenderMode } from './routes/route-config';
import { RouteTreeNodeMetadata } from './routes/route-tree';
import { ServerRouter } from './routes/router';
import { sha256 } from './utils/crypto';
import { InlineCriticalCssProcessor } from './utils/inline-critical-css';
import { LRUCache } from './utils/lru-cache';
import { AngularBootstrap, renderAngular } from './utils/ng';
import { joinUrlParts, stripIndexHtmlFromURL, stripLeadingSlash } from './utils/url';

/**
 * Maximum number of critical CSS entries the cache can store.
 * This value determines the capacity of the LRU (Least Recently Used) cache, which stores critical CSS for pages.
 */
const MAX_INLINE_CSS_CACHE_ENTRIES = 50;

/**
 * A mapping of `RenderMode` enum values to corresponding string representations.
 *
 * This record is used to map each `RenderMode` to a specific string value that represents
 * the server context. The string values are used internally to differentiate
 * between various rendering strategies when processing routes.
 *
 * - `RenderMode.Prerender` maps to `'ssg'` (Static Site Generation).
 * - `RenderMode.Server` maps to `'ssr'` (Server-Side Rendering).
 * - `RenderMode.AppShell` maps to `'app-shell'` (pre-rendered application shell).
 * - `RenderMode.Client` maps to an empty string `''` (Client-Side Rendering, no server context needed).
 */
const SERVER_CONTEXT_VALUE: Record<RenderMode, string> = {
  [RenderMode.Prerender]: 'ssg',
  [RenderMode.Server]: 'ssr',
  [RenderMode.AppShell]: 'app-shell',
  [RenderMode.Client]: '',
};

/**
 * Represents a locale-specific Angular server application managed by the server application engine.
 *
 * The `AngularServerApp` class handles server-side rendering and asset management for a specific locale.
 */
export class AngularServerApp {
  /**
   * Hooks for extending or modifying the behavior of the server application.
   * This instance can be used to attach custom functionality to various events in the server application lifecycle.
   */
  hooks = new Hooks();

  /**
   * The manifest associated with this server application.
   */
  private readonly manifest = getAngularAppManifest();

  /**
   * An instance of ServerAsset that handles server-side asset.
   */
  private readonly assets = new ServerAssets(this.manifest);

  /**
   * The router instance used for route matching and handling.
   */
  private router: ServerRouter | undefined;

  /**
   * The `inlineCriticalCssProcessor` is responsible for handling critical CSS inlining.
   */
  private inlineCriticalCssProcessor: InlineCriticalCssProcessor | undefined;

  /**
   * The bootstrap mechanism for the server application.
   */
  private boostrap: AngularBootstrap | undefined;

  /**
   * Cache for storing critical CSS for pages.
   * Stores a maximum of MAX_INLINE_CSS_CACHE_ENTRIES entries.
   *
   * Uses an LRU (Least Recently Used) eviction policy, meaning that when the cache is full,
   * the least recently accessed page's critical CSS will be removed to make space for new entries.
   */
  private readonly criticalCssLRUCache = new LRUCache<string, string>(MAX_INLINE_CSS_CACHE_ENTRIES);

  /**
   * Renders a page based on the provided URL via server-side rendering and returns the corresponding HTTP response.
   * The rendering process can be interrupted by an abort signal, where the first resolved promise (either from the abort
   * or the render process) will dictate the outcome.
   *
   * @param url - The full URL to be processed and rendered by the server.
   * @param signal - (Optional) An `AbortSignal` object that allows for the cancellation of the rendering process.
   * @returns A promise that resolves to the generated HTTP response object, or `null` if no matching route is found.
   */
  renderStatic(url: URL, signal?: AbortSignal): Promise<Response | null> {
    const request = new Request(url, { signal });

    return this.handleAbortableRendering(request, /** isSsrMode */ false);
  }

  /**
   * Handles an incoming HTTP request by serving prerendered content, performing server-side rendering,
   * or delivering a static file for client-side rendered routes based on the `RenderMode` setting.
   *
   * @param request - The HTTP request to handle.
   * @param requestContext - Optional context for rendering, such as metadata associated with the request.
   * @returns A promise that resolves to the resulting HTTP response object, or `null` if no matching Angular route is found.
   *
   * @remarks A request to `https://www.example.com/page/index.html` will serve or render the Angular route
   * corresponding to `https://www.example.com/page`.
   */
  async handle(request: Request, requestContext?: unknown): Promise<Response | null> {
    const url = new URL(request.url);
    this.router ??= await ServerRouter.from(this.manifest, url);

    const matchedRoute = this.router.match(url);
    if (!matchedRoute) {
      // Not a known Angular route.
      return null;
    }

    if (matchedRoute.renderMode === RenderMode.Prerender) {
      const response = await this.handleServe(request, matchedRoute);
      if (response) {
        return response;
      }
    }

    return this.handleAbortableRendering(
      request,
      /** isSsrMode */ true,
      matchedRoute,
      requestContext,
    );
  }

  /**
   * Retrieves the matched route for the incoming request based on the request URL.
   *
   * @param request - The incoming HTTP request to match against routes.
   * @returns A promise that resolves to the matched route metadata or `undefined` if no route matches.
   */
  private async getMatchedRoute(request: Request): Promise<RouteTreeNodeMetadata | undefined> {
    this.router ??= await ServerRouter.from(this.manifest, new URL(request.url));

    return this.router.match(new URL(request.url));
  }

  /**
   * Handles serving a prerendered static asset if available for the matched route.
   *
   * @param request - The incoming HTTP request for serving a static page.
   * @param matchedRoute - Optional parameter representing the metadata of the matched route for rendering.
   * If not provided, the method attempts to find a matching route based on the request URL.
   * @returns A promise that resolves to a `Response` object if the prerendered page is found, or `null`.
   */
  private async handleServe(
    request: Request,
    matchedRoute?: RouteTreeNodeMetadata,
  ): Promise<Response | null> {
    matchedRoute ??= await this.getMatchedRoute(request);
    if (!matchedRoute) {
      return null;
    }

    const { headers, renderMode } = matchedRoute;
    if (renderMode !== RenderMode.Prerender) {
      return null;
    }

    const { pathname } = stripIndexHtmlFromURL(new URL(request.url));
    const assetPath = stripLeadingSlash(joinUrlParts(pathname, 'index.html'));
    if (!this.assets.hasServerAsset(assetPath)) {
      return null;
    }

    const { text, hash, size } = this.assets.getServerAsset(assetPath);
    const etag = `"${hash}"`;

    return request.headers.get('if-none-match') === etag
      ? new Response(undefined, { status: 304, statusText: 'Not Modified' })
      : new Response(await text(), {
          headers: {
            'Content-Length': size.toString(),
            'ETag': etag,
            'Content-Type': 'text/html;charset=UTF-8',
            ...headers,
          },
        });
  }

  /**
   * Handles the server-side rendering process for the given HTTP request, allowing for abortion
   * of the rendering if the request is aborted. This method matches the request URL to a route
   * and performs rendering if a matching route is found.
   *
   * @param request - The incoming HTTP request to be processed. It includes a signal to monitor
   * for abortion events.
   * @param isSsrMode - A boolean indicating whether the rendering is performed in server-side
   * rendering (SSR) mode.
   * @param matchedRoute - Optional parameter representing the metadata of the matched route for
   * rendering. If not provided, the method attempts to find a matching route based on the request URL.
   * @param requestContext - Optional additional context for rendering, such as request metadata.
   *
   * @returns A promise that resolves to the rendered response, or null if no matching route is found.
   * If the request is aborted, the promise will reject with an `AbortError`.
   */
  private async handleAbortableRendering(
    request: Request,
    isSsrMode: boolean,
    matchedRoute?: RouteTreeNodeMetadata,
    requestContext?: unknown,
  ): Promise<Response | null> {
    return Promise.race([
      new Promise<never>((_, reject) => {
        request.signal.addEventListener(
          'abort',
          () => {
            const abortError = new Error(
              `Request for: ${request.url} was aborted.\n${request.signal.reason}`,
            );
            abortError.name = 'AbortError';
            reject(abortError);
          },
          { once: true },
        );
      }),
      this.handleRendering(request, isSsrMode, matchedRoute, requestContext),
    ]);
  }

  /**
   * Handles the server-side rendering process for the given HTTP request.
   * This method matches the request URL to a route and performs rendering if a matching route is found.
   *
   * @param request - The incoming HTTP request to be processed.
   * @param isSsrMode - A boolean indicating whether the rendering is performed in server-side rendering (SSR) mode.
   * @param matchedRoute - Optional parameter representing the metadata of the matched route for rendering.
   * If not provided, the method attempts to find a matching route based on the request URL.
   * @param requestContext - Optional additional context for rendering, such as request metadata.
   *
   * @returns A promise that resolves to the rendered response, or null if no matching route is found.
   */
  private async handleRendering(
    request: Request,
    isSsrMode: boolean,
    matchedRoute?: RouteTreeNodeMetadata,
    requestContext?: unknown,
  ): Promise<Response | null> {
    matchedRoute ??= await this.getMatchedRoute(request);
    if (!matchedRoute) {
      return null;
    }

    const { redirectTo, status } = matchedRoute;
    const url = new URL(request.url);

    if (redirectTo !== undefined) {
      // Note: The status code is validated during route extraction.
      // 302 Found is used by default for redirections
      // See: https://developer.mozilla.org/en-US/docs/Web/API/Response/redirect_static#status
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return Response.redirect(new URL(redirectTo, url), (status as any) ?? 302);
    }

    const { renderMode = isSsrMode ? RenderMode.Server : RenderMode.Prerender, headers } =
      matchedRoute;

    const platformProviders: StaticProvider[] = [];
    let responseInit: ResponseInit | undefined;

    if (isSsrMode) {
      // Initialize the response with status and headers if available.
      responseInit = {
        status,
        headers: new Headers({
          'Content-Type': 'text/html;charset=UTF-8',
          ...headers,
        }),
      };

      if (renderMode === RenderMode.Server) {
        // Configure platform providers for request and response only for SSR.
        platformProviders.push(
          {
            provide: REQUEST,
            useValue: request,
          },
          {
            provide: REQUEST_CONTEXT,
            useValue: requestContext,
          },
          {
            provide: RESPONSE_INIT,
            useValue: responseInit,
          },
        );
      } else if (renderMode === RenderMode.Client) {
        return new Response(
          await this.assets.getServerAsset('index.csr.html').text(),
          responseInit,
        );
      }
    }

    const {
      manifest: { bootstrap, inlineCriticalCss, locale },
      hooks,
      assets,
    } = this;

    if (locale !== undefined) {
      platformProviders.push({
        provide: LOCALE_ID,
        useValue: locale,
      });
    }

    let html = await assets.getIndexServerHtml().text();
    // Skip extra microtask if there are no pre hooks.
    if (hooks.has('html:transform:pre')) {
      html = await hooks.run('html:transform:pre', { html, url });
    }

    this.boostrap ??= await bootstrap();

    html = await renderAngular(
      html,
      this.boostrap,
      url,
      platformProviders,
      SERVER_CONTEXT_VALUE[renderMode],
    );

    if (inlineCriticalCss) {
      // Optionally inline critical CSS.
      this.inlineCriticalCssProcessor ??= new InlineCriticalCssProcessor((path: string) => {
        const fileName = path.split('/').pop() ?? path;

        return this.assets.getServerAsset(fileName).text();
      });

      // TODO(alanagius): remove once Node.js version 18 is no longer supported.
      if (isSsrMode && typeof crypto === 'undefined') {
        // eslint-disable-next-line no-console
        console.error(
          `The global 'crypto' module is unavailable. ` +
            `If you are running on Node.js, please ensure you are using version 20 or later, ` +
            `which includes built-in support for the Web Crypto module.`,
        );
      }

      if (isSsrMode && typeof crypto !== 'undefined') {
        // Only cache if we are running in SSR Mode.
        const cacheKey = await sha256(html);
        let htmlWithCriticalCss = this.criticalCssLRUCache.get(cacheKey);
        if (htmlWithCriticalCss === undefined) {
          htmlWithCriticalCss = await this.inlineCriticalCssProcessor.process(html);
          this.criticalCssLRUCache.put(cacheKey, htmlWithCriticalCss);
        }

        html = htmlWithCriticalCss;
      } else {
        html = await this.inlineCriticalCssProcessor.process(html);
      }
    }

    return new Response(html, responseInit);
  }
}

let angularServerApp: AngularServerApp | undefined;

/**
 * Retrieves or creates an instance of `AngularServerApp`.
 * - If an instance of `AngularServerApp` already exists, it will return the existing one.
 * - If no instance exists, it will create a new one with the provided options.
 * @returns The existing or newly created instance of `AngularServerApp`.
 */
export function getOrCreateAngularServerApp(): AngularServerApp {
  return (angularServerApp ??= new AngularServerApp());
}

/**
 * Destroys the existing `AngularServerApp` instance, releasing associated resources and resetting the
 * reference to `undefined`.
 *
 * This function is primarily used to enable the recreation of the `AngularServerApp` instance,
 * typically when server configuration or application state needs to be refreshed.
 */
export function destroyAngularServerApp(): void {
  if (typeof ngDevMode === 'undefined' || ngDevMode) {
    // Need to clean up GENERATED_COMP_IDS map in `@angular/core`.
    // Otherwise an incorrect component ID generation collision detected warning will be displayed in development.
    // See: https://github.com/angular/angular-cli/issues/25924
    ɵresetCompiledComponents();
  }

  angularServerApp = undefined;
}
