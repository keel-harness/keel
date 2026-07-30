export {};

declare global {
  const Bun: {
    build(options: Bun.BuildOptions): Promise<Bun.BuildOutput>;
  };

  namespace Bun {
    interface BuildOptions {
      readonly entrypoints: readonly string[];
      readonly target?: "node";
      readonly conditions?: readonly string[];
      readonly external?: readonly string[];
      readonly outdir?: string;
      readonly naming?: string;
      readonly metafile?: boolean;
      readonly compile?: {
        readonly target: string;
        readonly outfile: string;
        // Bun v1.3.3+: disable the runtime's automatic loading of a cwd `.env`/`.env.local` and
        // `bunfig.toml` in the compiled binary (SEC-012 / ADR-0038 — trust-before-parse). `@types/bun`
        // lags on these fields, so they are declared here alongside the rest of the local shim.
        readonly autoloadDotenv?: boolean;
        readonly autoloadBunfig?: boolean;
      };
      readonly plugins?: readonly Plugin[];
    }

    interface BuildOutput {
      readonly success: boolean;
      readonly logs: readonly unknown[];
      readonly metafile?: {
        readonly inputs: Readonly<Record<string, unknown>>;
      };
    }

    interface Plugin {
      readonly name: string;
      setup(build: PluginBuilder): void;
    }

    interface PluginBuilder {
      onResolve(options: OnResolveOptions, callback: OnResolveCallback): void;
      onLoad(options: OnLoadOptions, callback: OnLoadCallback): void;
    }

    interface OnResolveOptions {
      readonly filter: RegExp;
    }

    interface OnLoadOptions {
      readonly filter: RegExp;
      readonly namespace: string;
    }

    interface OnResolveArgs {
      readonly path: string;
    }

    interface OnResolveResult {
      readonly path: string;
      readonly namespace?: string;
    }

    interface OnLoadResult {
      readonly contents: string;
      readonly loader: "js";
    }

    interface OnLoadArgs {
      readonly path: string;
      readonly namespace: string;
    }

    type OnResolveCallback = (args: OnResolveArgs) => OnResolveResult | Promise<OnResolveResult>;
    type OnLoadCallback = (args: OnLoadArgs) => OnLoadResult | Promise<OnLoadResult>;
  }
}
