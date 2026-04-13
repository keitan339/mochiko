const fs = require("fs");
const path = require("path");
const webpack = require("webpack");

const urlPrefix = process.env.NEXT_PUBLIC_URL_PREFIX;

const isDevelopment = process.env.NODE_ENV === "development";
const isProduction = process.env.NODE_ENV === "production";

module.exports = (() => {
  // 共通設定
  /** @type {import('next').NextConfig} */
  const commonSetting = {
    basePath: urlPrefix,
    assetPrefix: "",
    reactStrictMode: false,
    sassOptions: {
      includePaths: [path.join(__dirname, "src", "styles")],
    },
    publicRuntimeConfig: {
      urlPrefix: urlPrefix,
    },
    pageExtensions: urlPrefix === "/app" && isProduction ? ["tsx", "ts"] : ["dev.tsx", "tsx", "ts"],
    webpack: (config, { isServer, dev, webpack }) => {
      config.resolve.alias["@dcweb/dcweb-core"] = fs.existsSync(path.resolve(__dirname, "node_modules/@dcweb/dcweb-core"))
        ? path.resolve(__dirname, "node_modules/@dcweb/dcweb-core")
        : path.resolve(__dirname, "../../node_modules/@dcweb/dcweb-core");
      config.resolve.alias["@dcweb/dcweb-public-ui"] = fs.existsSync(path.resolve(__dirname, "node_modules/@dcweb/dcweb-public-ui"))
        ? path.resolve(__dirname, "node_modules/@dcweb/dcweb-public-ui")
        : path.resolve(__dirname, "../../node_modules/@dcweb/dcweb-public-ui");
      config.resolve.alias["@mui/material"] = path.resolve(__dirname, "../../node_modules/@mui/material");
      config.resolve.alias["react-hook-form"] = path.resolve(__dirname, "../../node_modules/react-hook-form");

      if (!dev && !isServer) {
        config.devtool = "hidden-source-map";

        config.parallelism = 1;

        config.optimization.chunkIds = "deterministic";
        config.optimization.moduleIds = false;

        // モジュールID/チャンクIDの決定性を確保するプラグイン。
        // CI環境(CodeBuild等)ではワークディレクトリパスがビルドごとに変わり
        // (例: /codebuild/output/srcXXXXXX/src/)、module.identifier() に含まれる
        // 絶対パスのハッシュが不安定になる。
        // DeterministicModuleIdsPlugin の前(beforeModuleIds)に全モジュール型の
        // identifier()に影響するフィールドから絶対パスを相対パスに変換する。
        //
        // 対象モジュール型と書き換えフィールド:
        //   NormalModule:       request
        //   CssModule:          _identifier, context, _context
        //   ConcatenatedModule: _identifier + 子モジュールの request
        //   RawModule:          identifierStr
        const projectRoot = path.resolve(__dirname, "../..");
        config.plugins.push({
          apply(compiler) {
            compiler.hooks.compilation.tap("StableModuleIds", (compilation) => {
              compilation.hooks.beforeModuleIds.tap("StableModuleIds", (modules) => {
                const root = projectRoot + "/";
                const encodedRoot = projectRoot.split("/").join("%2F") + "%2F";
                const relativize = (s) => s.split(root).join("./").split(encodedRoot).join(".%2F");

                for (const m of modules) {
                  // NormalModule: request
                  if (m.request && m.request.includes(projectRoot)) {
                    m.request = relativize(m.request);
                  }
                  // CssModule: _identifier, context, _context
                  if (m._identifier && typeof m._identifier === "string" && m._identifier.includes(projectRoot)) {
                    m._identifier = relativize(m._identifier);
                  }
                  if (m._context && typeof m._context === "string" && m._context.includes(projectRoot)) {
                    m._context = relativize(m._context);
                  }
                  if (m.context && typeof m.context === "string" && m.context.includes(projectRoot)) {
                    m.context = relativize(m.context);
                  }
                  // RawModule: identifierStr
                  if (m.identifierStr && typeof m.identifierStr === "string" && m.identifierStr.includes(projectRoot)) {
                    m.identifierStr = relativize(m.identifierStr);
                  }
                  // ConcatenatedModule: _modules (子モジュールのrequest)
                  if (m._modules) {
                    for (const sub of m._modules) {
                      if (sub.request && sub.request.includes(projectRoot)) {
                        sub.request = relativize(sub.request);
                      }
                      if (sub._identifier && typeof sub._identifier === "string" && sub._identifier.includes(projectRoot)) {
                        sub._identifier = relativize(sub._identifier);
                      }
                    }
                  }
                }
              });
            });
          },
        });

        config.plugins.push(
          new webpack.ids.DeterministicModuleIdsPlugin({
            maxLength: 16,
          }),
        );
      }

      if (!dev) {
      }

      return config;
    },

    compiler: {
      removeConsole: isProduction
        ? {
            exclude: ["error", "trace"],
          }
        : false,
    },
  };

  // 開発向け設定
  /** @type {import('next').NextConfig} */
  const devSetting = {
    onDemandEntries: {
      maxInactiveAge: 60 * 60 * 1000,
      pagesBufferLength: 10,
    },

    async redirects() {
      return [
        {
          source: "/",
          destination: urlPrefix + "/v160000",
          basePath: false,
          permanent: false,
        },
      ];
    },
  };

  // ビルド向け設定
  /** @type {import('next').NextConfig} */
  const productionSetting = {
    output: "export",
    generateBuildId: async () => {
      return "fix";
    },
    eslint: {
      ignoreDuringBuilds: true,
    },
    typescript: {
      tsconfigPath: "tsconfig.build.json",
    },
  };

  // 最終設定
  const setting = { ...commonSetting, ...(isDevelopment && devSetting), ...(isProduction && productionSetting) };
  return setting;
})();
