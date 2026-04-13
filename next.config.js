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
