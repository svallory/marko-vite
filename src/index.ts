import type * as vite from "vite";
import type * as Compiler from "@marko/compiler";

import fs from "fs";
import path from "path";
import crypto from "crypto";
import anyMatch from "anymatch";
import { pathToFileURL } from "url";

import getServerEntryTemplate from "./server-entry-template";
import {
  generateInputDoc,
  generateDocManifest,
  type DocManifest,
} from "./manifest-generator";
import esbuildPlugin from "./esbuild-plugin";
import interopBabelPlugin from "./babel-plugin-cjs-interop";
import type { PluginObj } from "@babel/core";
import { isCJSModule } from "./resolve";
import {
  getRenderAssetsRuntime,
  renderAssetsRuntimeId,
} from "./render-assets-runtime";
import renderAssetsTransform from "./render-assets-transform";
import relativeAssetsTransform from "./relative-assets-transform";
import { ReadOncePersistedStore } from "./read-once-persisted-store";

export namespace API {
  export type getMarkoAssetCodeForEntry = (id: string) => string | void;
}

export interface Options {
  // Defaults to true, set to false to disable automatic component discovery and hydration.
  linked?: boolean;
  // Override the Marko compiler instance being used. (primarily for tools wrapping this module)
  compiler?: string;
  // Sets a custom runtimeId to avoid conflicts with multiple copies of Marko on the same page.
  runtimeId?: string;
  // Overrides the Marko translator being used.
  translator?: string;
  // If set, will use the provided string as a variable name and prefix all assets paths with that variable.
  basePathVar?: string;
  // Overrides the Babel config that Marko will use.
  babelConfig?: Compiler.Config["babelConfig"];
}

interface BrowserManifest {
  [id: string]: DocManifest;
}

interface ServerManifest {
  entries: {
    [entryId: string]: string;
  };
  entrySources: {
    [entryId: string]: string;
  };
  chunksNeedingAssets: string[];
}

interface VirtualFile {
  code: string;
  map?: any;
}

type DeferredPromise<T> = Promise<T> & {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
};

const POSIX_SEP = "/";
const WINDOWS_SEP = "\\";

const normalizePath =
  path.sep === WINDOWS_SEP
    ? (id: string) => id.replace(/\\/g, POSIX_SEP)
    : (id: string) => id;
const virtualFiles = new Map<
  string,
  VirtualFile | DeferredPromise<VirtualFile>
>();
const extReg = /\.[^.]+$/;
const queryReg = /\?marko-[^?]+$/;
const browserEntryQuery = "?marko-browser-entry";
const serverEntryQuery = "?marko-server-entry";
const virtualFileQuery = "?marko-virtual";
const browserQuery = "?marko-browser";
const markoExt = ".marko";
const htmlExt = ".html";
const resolveOpts = { skipSelf: true };
const configsByFileSystem = new Map<
  typeof fs,
  Map<Compiler.Config, Compiler.Config>
>();
const cache = new Map<unknown, unknown>();
const babelCaller = {
  name: "@marko/vite",
  supportsStaticESM: true,
  supportsDynamicImport: true,
  supportsTopLevelAwait: true,
  supportsExportNamespaceFrom: true,
};
let registeredTagLib = false;

export default function markoPlugin(opts: Options = {}): vite.Plugin[] {
  let compiler: typeof Compiler;
  let { linked = true } = opts;
  let runtimeId: string | undefined;
  let basePathVar: string | undefined;
  let baseConfig: Compiler.Config;
  let ssrConfig: Compiler.Config;
  let ssrCjsBuildConfig: Compiler.Config;
  let ssrCjsServeConfig: Compiler.Config;
  let domConfig: Compiler.Config;
  let hydrateConfig: Compiler.Config;

  const resolveVirtualDependency: Compiler.Config["resolveVirtualDependency"] =
    (from, dep) => {
      const normalizedFrom = normalizePath(from);
      const query = `${virtualFileQuery}&id=${
        Buffer.from(dep.virtualPath).toString("base64url") +
        path.extname(dep.virtualPath)
      }`;
      const id = normalizePath(normalizedFrom) + query;

      if (devServer) {
        const prev = virtualFiles.get(id);
        if (isDeferredPromise(prev)) {
          prev.resolve(dep);
        }
      }

      virtualFiles.set(id, dep);
      return `./${path.posix.basename(normalizedFrom) + query}`;
    };

  let root: string;
  let devEntryFile: string;
  let devEntryFilePosix: string;
  let renderAssetsRuntimeCode: string;
  let isTest = false;
  let isBuild = false;
  let isSSRBuild = false;
  let devServer: vite.ViteDevServer;
  let serverManifest: ServerManifest | undefined;
  let basePath = "/";
  let getMarkoAssetFns: undefined | API.getMarkoAssetCodeForEntry[];
  const entryIds = new Set<string>();
  const cachedSources = new Map<string, string>();
  const transformWatchFiles = new Map<string, string[]>();
  const transformOptionalFiles = new Map<string, string[]>();
  const store = new ReadOncePersistedStore<ServerManifest>(
    `vite-marko${runtimeId ? `-${runtimeId}` : ""}`,
  );

  return [
    {
      name: "marko-vite:pre",
      enforce: "pre", // Must be pre to allow us to resolve assets before vite.
      async config(config, env) {
        let optimize = env.mode === "production";

        if ("MARKO_DEBUG" in process.env) {
          optimize =
            process.env.MARKO_DEBUG === "false" ||
            process.env.MARKO_DEBUG === "0";
        } else {
          process.env.MARKO_DEBUG = optimize ? "false" : "true";
        }

        compiler ??= (await import(
          opts.compiler || "@marko/compiler"
        )) as typeof Compiler;

        runtimeId = opts.runtimeId;
        basePathVar = opts.basePathVar;

        baseConfig = {
          cache,
          optimize,
          runtimeId,
          sourceMaps: true,
          writeVersionComment: false,
          babelConfig: opts.babelConfig
            ? {
                ...opts.babelConfig,
                caller: opts.babelConfig.caller
                  ? {
                      name: "@marko/vite",
                      supportsStaticESM: true,
                      supportsDynamicImport: true,
                      supportsTopLevelAwait: true,
                      supportsExportNamespaceFrom: true,
                      ...opts.babelConfig.caller,
                    }
                  : babelCaller,
              }
            : {
                babelrc: false,
                configFile: false,
                browserslistConfigFile: false,
                caller: babelCaller,
              },
        };

        ssrConfig = {
          ...baseConfig,
          resolveVirtualDependency,
          output: "html",
        };

        ssrCjsServeConfig = {
          ...ssrConfig,
          ast: true,
          code: false,
          sourceMaps: false,
        };

        domConfig = {
          ...baseConfig,
          resolveVirtualDependency,
          output: "dom",
        };

        hydrateConfig = {
          ...baseConfig,
          resolveVirtualDependency,
          output: "hydrate",
        };

        compiler.configure(baseConfig);
        root = normalizePath(config.root || process.cwd());
        devEntryFile = path.join(root, "index.html");
        devEntryFilePosix = normalizePath(devEntryFile);
        isTest = env.mode === "test";
        isBuild = env.command === "build";
        isSSRBuild = isBuild && linked && Boolean(config.build!.ssr);
        renderAssetsRuntimeCode = getRenderAssetsRuntime({
          isBuild,
          basePathVar,
          runtimeId,
        });

        if (isTest) {
          linked = false;

          if (
            ((config as any).test?.environment as string | undefined)?.includes(
              "dom",
            )
          ) {
            config.resolve ??= {};
            config.resolve.conditions ??= [];
            config.resolve.conditions.push("browser");
          }
        }

        if (!registeredTagLib) {
          registeredTagLib = true;
          compiler.taglib.register("@marko/vite", {
            "<head>": { transformer: renderAssetsTransform },
            "<body>": { transformer: renderAssetsTransform },
            "<*>": { transformer: relativeAssetsTransform },
          });
        }

        const optimizeDeps = (config.optimizeDeps ??= {});
        optimizeDeps.entries ??= [
          "**/*.marko",
          "!**/__snapshots__/**",
          `!**/__tests__/**`,
          `!**/coverage/**`,
        ];

        const domDeps = compiler.getRuntimeEntryFiles("dom", opts.translator);
        optimizeDeps.include = optimizeDeps.include
          ? [...optimizeDeps.include, ...domDeps]
          : domDeps;

        const optimizeExtensions = (optimizeDeps.extensions ??= []);
        optimizeExtensions.push(".marko");

        const esbuildOptions = (optimizeDeps.esbuildOptions ??= {});
        const esbuildPlugins = (esbuildOptions.plugins ??= []);
        esbuildPlugins.push(esbuildPlugin(compiler, baseConfig));

        const ssr = (config.ssr ??= {});
        let { noExternal } = ssr;
        if (noExternal !== true) {
          const noExternalReg = /\.marko$/;
          if (noExternal) {
            if (Array.isArray(noExternal)) {
              noExternal.push(noExternalReg);
            } else {
              noExternal = [noExternal, noExternalReg];
            }
          } else {
            noExternal = noExternalReg;
          }
        }

        if (basePathVar) {
          config.experimental ??= {};

          if (config.experimental.renderBuiltUrl) {
            throw new Error(
              "Cannot use @marko/vite `basePathVar` with Vite's `renderBuiltUrl` option.",
            );
          }

          const assetsDir =
            config.build?.assetsDir?.replace(/[/\\]$/, "") ?? "assets";
          const assetsDirLen = assetsDir.length;
          const assetsDirEnd = assetsDirLen + 1;
          const trimAssertsDir = (fileName: string) => {
            if (fileName.startsWith(assetsDir)) {
              switch (fileName[assetsDirLen]) {
                case POSIX_SEP:
                case WINDOWS_SEP:
                  return fileName.slice(assetsDirEnd);
              }
            }

            return fileName;
          };
          config.experimental.renderBuiltUrl = (
            fileName,
            { hostType, ssr },
          ) => {
            switch (hostType) {
              case "html":
                return trimAssertsDir(fileName);
              case "js":
                return {
                  runtime: `${
                    ssr
                      ? basePathVar
                      : `$mbp${runtimeId ? `_${runtimeId}` : ""}`
                  }+${JSON.stringify(trimAssertsDir(fileName))}`,
                };
              default:
                return { relative: true };
            }
          };
        }
      },
      configResolved(config) {
        basePath = config.base;

        ssrCjsBuildConfig = {
          ...ssrConfig,
          //modules: 'cjs'
          babelConfig: {
            ...ssrConfig.babelConfig,
            plugins: (
              (ssrConfig.babelConfig!.plugins || []) as (
                | PluginObj<any>
                | string
              )[]
            ).concat(
              interopBabelPlugin({
                extensions: config.resolve.extensions,
                conditions: config.resolve.conditions,
              }),
            ),
          },
        };

        getMarkoAssetFns = undefined;
        for (const plugin of config.plugins) {
          const fn = plugin.api?.getMarkoAssetCodeForEntry as
            | undefined
            | API.getMarkoAssetCodeForEntry;
          if (fn) {
            if (getMarkoAssetFns) {
              getMarkoAssetFns.push(fn);
            } else {
              getMarkoAssetFns = [fn];
            }
          }
        }
      },
      configureServer(_server) {
        ssrConfig.hot = domConfig.hot = true;
        devServer = _server;
        devServer.watcher.on("all", (type, filename) => {
          cachedSources.delete(filename);

          if (type === "unlink") {
            entryIds.delete(filename);
            transformWatchFiles.delete(filename);
            transformOptionalFiles.delete(filename);
          }

          for (const [id, files] of transformWatchFiles) {
            if (anyMatch(files, filename)) {
              devServer.watcher.emit("change", id);
            }
          }

          if (type === "add" || type === "unlink") {
            for (const [id, files] of transformOptionalFiles) {
              if (anyMatch(files, filename)) {
                devServer.watcher.emit("change", id);
              }
            }
          }
        });
      },

      handleHotUpdate(ctx) {
        compiler.taglib.clearCaches();
        baseConfig.cache!.clear();

        for (const [, cache] of configsByFileSystem) {
          cache.clear();
        }

        for (const mod of ctx.modules) {
          if (mod.id && virtualFiles.has(mod.id)) {
            virtualFiles.set(mod.id, createDeferredPromise());
          }
        }
      },

      async buildStart(inputOptions) {
        if (isBuild && linked && !isSSRBuild) {
          try {
            serverManifest = await store.read();
            inputOptions.input = toHTMLEntries(root, serverManifest.entries);
            for (const entry in serverManifest.entrySources) {
              const id = normalizePath(path.resolve(root, entry));
              entryIds.add(id);
              cachedSources.set(id, serverManifest.entrySources[entry]);
            }
          } catch (err) {
            this.error(
              `You must run the "ssr" build before the "browser" build.`,
            );
          }

          if (isEmpty(inputOptions.input)) {
            this.error("No Marko files were found when compiling the server.");
          }
        }
      },
      async resolveId(importee, importer, importOpts, ssr = importOpts.ssr) {
        if (virtualFiles.has(importee)) {
          return importee;
        }

        if (importee === renderAssetsRuntimeId) {
          return { id: renderAssetsRuntimeId };
        }

        let importeeQuery = getMarkoQuery(importee);

        if (importeeQuery) {
          importee = importee.slice(0, -importeeQuery.length);
        } else if (!(importOpts as any).scan) {
          if (
            ssr &&
            linked &&
            importer &&
            importer[0] !== "\0" &&
            (importer !== devEntryFile ||
              normalizePath(importer) !== devEntryFilePosix) && // Vite tries to resolve against an `index.html` in some cases, we ignore it here.
            isMarkoFile(importee) &&
            !isMarkoFile(importer.replace(queryReg, ""))
          ) {
            importeeQuery = serverEntryQuery;
          } else if (
            !ssr &&
            isBuild &&
            importer &&
            isMarkoFile(importee) &&
            this.getModuleInfo(importer)?.isEntry
          ) {
            importeeQuery = browserEntryQuery;
          } else if (
            !isBuild &&
            linked &&
            !ssr &&
            !importeeQuery &&
            isMarkoFile(importee)
          ) {
            importeeQuery = browserQuery;
          }
        }

        if (importeeQuery) {
          const resolved =
            importee[0] === "."
              ? {
                  id: normalizePath(
                    importer
                      ? path.resolve(importer, "..", importee)
                      : path.resolve(root, importee),
                  ),
                }
              : await this.resolve(importee, importer, resolveOpts);

          if (resolved) {
            resolved.id += importeeQuery;
          }

          return resolved;
        }

        if (importer) {
          const importerQuery = getMarkoQuery(importer);
          if (importerQuery) {
            importer = importer.slice(0, -importerQuery.length);

            if (importee[0] === ".") {
              const resolved = normalizePath(
                path.resolve(importer, "..", importee),
              );
              if (resolved === normalizePath(importer)) return resolved;
            }

            return this.resolve(importee, importer, resolveOpts);
          }
        }

        return null;
      },
      async load(rawId) {
        const id = stripVersionAndTimeStamp(rawId);

        if (id === renderAssetsRuntimeId) {
          return renderAssetsRuntimeCode;
        }

        const query = getMarkoQuery(id);
        switch (query) {
          case serverEntryQuery: {
            entryIds.add(id.slice(0, -query.length));
            return null;
          }
          case browserEntryQuery:
          case browserQuery: {
            // The goal below is to cached source content when in linked mode
            // to avoid loading from disk for both server and browser builds.
            // This is to support virtual Marko entry files.
            return cachedSources.get(id.slice(0, -query.length)) || null;
          }
        }

        return virtualFiles.get(id) || null;
      },
      async transform(source, rawId, ssr) {
        let id = stripVersionAndTimeStamp(rawId);
        const info = isBuild ? this.getModuleInfo(id) : undefined;
        const arcSourceId = info?.meta.arcSourceId;
        if (arcSourceId) {
          const arcFlagSet = info.meta.arcFlagSet;
          id = arcFlagSet
            ? arcSourceId.replace(extReg, `[${arcFlagSet.join("+")}]$&`)
            : arcSourceId;
        }

        const isSSR = typeof ssr === "object" ? ssr.ssr : ssr;
        const query = getMarkoQuery(id);

        if (query && !query.startsWith(virtualFileQuery)) {
          id = id.slice(0, -query.length);

          if (query === serverEntryQuery) {
            const fileName = id;
            let mainEntryData: string;
            id = `${id.slice(0, -markoExt.length)}.entry.marko`;
            cachedSources.set(fileName, source);

            if (isBuild) {
              const relativeFileName = path.posix.relative(root, fileName);
              const entryId = toEntryId(relativeFileName);
              serverManifest ??= {
                entries: {},
                entrySources: {},
                chunksNeedingAssets: [],
              };
              serverManifest.entries[entryId] = relativeFileName;
              serverManifest.entrySources[relativeFileName] = source;
              mainEntryData = JSON.stringify(entryId);
            } else {
              mainEntryData = JSON.stringify(
                await generateDocManifest(
                  basePath,
                  await devServer.transformIndexHtml(
                    "/",
                    generateInputDoc(
                      posixFileNameToURL(fileName, root) + browserEntryQuery,
                    ),
                  ),
                ),
              );
            }

            const entryData = [mainEntryData];
            if (getMarkoAssetFns) {
              for (const getMarkoAsset of getMarkoAssetFns) {
                const asset = getMarkoAsset(fileName);
                if (asset) {
                  entryData.push(asset);
                }
              }
            }

            source = await getServerEntryTemplate({
              fileName,
              entryData,
              runtimeId,
              basePathVar: isBuild ? basePathVar : undefined,
            });
          }
        }

        if (!isMarkoFile(id)) {
          return null;
        }

        if (isSSR) {
          if (linked) {
            cachedSources.set(id, source);
          }

          if (!query && isCJSModule(id)) {
            if (isBuild) {
              const { code, map, meta } = await compiler.compile(
                source,
                id,
                getConfigForFileSystem(info, ssrCjsBuildConfig),
              );

              return {
                code,
                map,
                meta: { arcSourceCode: source, arcScanIds: meta.analyzedTags },
              };
            } else {
              // For Marko files in CJS packages we create a facade
              // that loads the module as commonjs.
              const { ast } = await compiler.compile(
                source,
                id,
                ssrCjsServeConfig,
              );
              let namedExports = "";
              let code = `import { createRequire } from "module";\n`;
              code += `import "@marko/compiler/register.js";\n`;
              code += `const mod = createRequire(import.meta.url)(${JSON.stringify(
                id,
              )});\n`;

              for (const child of ast.program.body) {
                switch (child.type) {
                  case "ExportAllDeclaration":
                    code += `export * from ${JSON.stringify(
                      child.source.value,
                    )};\n`;
                    break;
                  case "ExportNamedDeclaration":
                    if (child.specifiers) {
                      for (const specifier of child.specifiers) {
                        if (specifier.exported.type === "Identifier") {
                          namedExports += `${specifier.exported.name},`;
                        } else {
                          namedExports += `mod[${JSON.stringify(
                            specifier.exported.value,
                          )}] as ${specifier.exported.value},`;
                        }
                      }
                    }

                    if (child.declaration) {
                      if ("id" in child.declaration && child.declaration.id) {
                        if (child.declaration.id.type === "Identifier") {
                          namedExports += `${child.declaration.id.name},`;
                        } else {
                          namedExports += `mod[${JSON.stringify(
                            child.declaration.id.value,
                          )}] as ${child.declaration.id.value},`;
                        }
                      }

                      if ("declarations" in child.declaration) {
                        for (const declaration of child.declaration
                          .declarations) {
                          if (declaration.id.type === "Identifier") {
                            namedExports += `${declaration.id.name},`;
                          }
                        }
                      }
                    }
                    break;
                }
              }

              code += `export const { ${namedExports} } = mod;\n`;
              code += `export default mod.default;\n`;
              return code;
            }
          }
        }

        const compiled = await compiler.compile(
          source,
          id,
          getConfigForFileSystem(
            info,
            isSSR
              ? ssrConfig
              : query === browserEntryQuery
                ? hydrateConfig
                : domConfig,
          ),
        );

        const { map, meta } = compiled;
        let { code } = compiled;

        if (query !== browserEntryQuery && devServer) {
          code += `\nif (import.meta.hot) import.meta.hot.accept(() => {});`;
        }

        if (devServer) {
          const templateName = getPosixBasenameWithoutExt(id);
          const optionalFilePrefix =
            path.dirname(id) +
            path.sep +
            (templateName === "index" ? "" : `${templateName}.`);

          for (const file of meta.watchFiles) {
            this.addWatchFile(file);
          }

          transformOptionalFiles.set(id, [
            `${optionalFilePrefix}style.*`,
            `${optionalFilePrefix}component.*`,
            `${optionalFilePrefix}component-browser.*`,
            `${optionalFilePrefix}marko-tag.json`,
          ]);

          transformWatchFiles.set(id, meta.watchFiles);
        }
        return {
          code,
          map,
          meta: isBuild
            ? { arcSourceCode: source, arcScanIds: meta.analyzedTags }
            : undefined,
        };
      },
    },
    {
      name: "marko-vite:post",
      apply: "build",
      enforce: "post", // We use a "post" plugin to allow us to read the final generated `.html` from vite.
      async generateBundle(outputOptions, bundle, isWrite) {
        if (!linked) {
          return;
        }

        if (!isWrite) {
          this.error(
            `Linked builds are currently only supported when in "write" mode.`,
          );
        }

        if (!serverManifest) {
          this.error(
            "No Marko files were found when bundling the server in linked mode.",
          );
        }

        if (isSSRBuild) {
          const dir = outputOptions.dir
            ? path.resolve(outputOptions.dir)
            : path.resolve(outputOptions.file!, "..");

          for (const fileName in bundle) {
            const chunk = bundle[fileName];

            if (chunk.type === "chunk") {
              for (const id in chunk.modules) {
                if (id.endsWith(serverEntryQuery)) {
                  serverManifest!.chunksNeedingAssets.push(
                    path.resolve(dir, fileName),
                  );
                  break;
                }
              }
            }
          }

          store.write(serverManifest!);
        } else {
          const browserManifest: BrowserManifest = {};

          for (const entryId in serverManifest!.entries) {
            const fileName = serverManifest!.entries[entryId];
            const chunkId = fileName + htmlExt;
            const chunk = bundle[chunkId];

            if (chunk?.type === "asset") {
              browserManifest[entryId] = {
                ...(await generateDocManifest(
                  basePath,
                  chunk.source.toString(),
                )),
                preload: undefined, // clear out preload for prod builds.
              } as any;

              delete bundle[chunkId];
            } else {
              this.error(
                `Marko template had unexpected output from vite, ${fileName}`,
              );
            }
          }

          const manifestStr = `;var __MARKO_MANIFEST__=${JSON.stringify(
            browserManifest,
          )};\n`;

          for (const fileName of serverManifest!.chunksNeedingAssets) {
            await fs.promises.appendFile(fileName, manifestStr);
          }
        }
      },
    },
  ];
}

function getMarkoQuery(id: string) {
  return queryReg.exec(id)?.[0] || "";
}

function isMarkoFile(id: string) {
  return id.endsWith(markoExt);
}

function toHTMLEntries(root: string, serverEntries: ServerManifest["entries"]) {
  const result: string[] = [];

  for (const id in serverEntries) {
    const markoFile = path.posix.join(root, serverEntries[id]);
    const htmlFile = markoFile + htmlExt;
    virtualFiles.set(htmlFile, {
      code: generateInputDoc(markoFile + browserEntryQuery),
    });
    result.push(htmlFile);
  }

  return result;
}

function toEntryId(id: string) {
  const lastSepIndex = id.lastIndexOf(POSIX_SEP);
  let name = id.slice(lastSepIndex + 1, id.indexOf(".", lastSepIndex));

  if (name === "index" || name === "template") {
    name = id.slice(
      id.lastIndexOf(POSIX_SEP, lastSepIndex - 1) + 1,
      lastSepIndex,
    );
  }

  return `${name}_${crypto
    .createHash("SHA1")
    .update(id)
    .digest("base64")
    .replace(/[/+]/g, "-")
    .slice(0, 4)}`;
}

function posixFileNameToURL(fileName: string, root: string) {
  const relativeURL = path.posix.relative(
    pathToFileURL(root).pathname,
    pathToFileURL(fileName).pathname,
  );
  if (relativeURL[0] === ".") {
    throw new Error(
      "@marko/vite: Entry templates must exist under the current root directory.",
    );
  }

  return `/${relativeURL}`;
}

function getPosixBasenameWithoutExt(file: string): string {
  const baseStart = file.lastIndexOf(POSIX_SEP) + 1;
  const extStart = file.indexOf(".", baseStart + 1);
  return file.slice(baseStart, extStart);
}

function createDeferredPromise<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  }) as DeferredPromise<T>;
  promise.resolve = resolve;
  promise.reject = reject;
  return promise;
}

function isDeferredPromise<T>(obj: unknown): obj is DeferredPromise<T> {
  return typeof (obj as Promise<T>)?.then === "function";
}

function isEmpty(obj: unknown) {
  for (const _ in obj as Record<string, unknown>) {
    return false;
  }

  return true;
}

function stripVersionAndTimeStamp(id: string) {
  const queryStart = id.indexOf("?");
  if (queryStart === -1) return id;
  const url = id.slice(0, queryStart);
  const query = id.slice(queryStart + 1).replace(/(?:^|[&])[vt]=[^&]+/g, "");
  if (query) return `${url}?${query}`;
  return url;
}

/**
 * For integration with arc-vite.
 * We create a unique Marko config tied to each arcFileSystem.
 */
function getConfigForFileSystem(
  info: vite.Rollup.ModuleInfo | undefined | null,
  config: Compiler.Config,
) {
  const fileSystem = info?.meta.arcFS;
  if (!fileSystem) return config;

  let configsForFileSystem = configsByFileSystem.get(fileSystem);
  if (!configsForFileSystem) {
    configsForFileSystem = new Map();
    configsByFileSystem.set(fileSystem, configsForFileSystem);
  }

  let configForFileSystem = configsForFileSystem.get(config);
  if (!configForFileSystem) {
    configForFileSystem = {
      ...config,
      fileSystem,
      cache: configsForFileSystem,
    };
    configsForFileSystem.set(config, configForFileSystem);
  }

  return configForFileSystem;
}
