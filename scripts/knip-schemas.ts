// @effect-diagnostics nodeBuiltinImport:off - Knip and the TypeScript compiler host use synchronous Node paths.
import * as NodePath from "node:path";
import type { Preprocessor } from "knip";
// Knip needs the legacy compiler API, which TypeScript 7 no longer exports.
import ts from "typescript-legacy";

const schemaTypeId = "~effect/Schema/Schema";

const preprocess: Preprocessor = (options) => {
  const categories = ["exports", "nsExports", "duplicates"] as const;
  const projects = new Map<string | undefined, Set<string>>();
  for (const category of categories) {
    for (const [filePath, issues] of Object.entries(options.issues[category])) {
      if (Object.keys(issues).length === 0) continue;
      const configPath = ts.findConfigFile(
        NodePath.dirname(NodePath.resolve(options.cwd, filePath)),
        ts.sys.fileExists,
      );
      const files = projects.get(configPath) ?? new Set<string>();
      files.add(filePath);
      projects.set(configPath, files);
    }
  }

  // Each tsconfig gets its own program, and most of them parse the same
  // dependency declarations; parsing them once per program dominated the run.
  // The binder stores option-dependent state on a source file, so only
  // programs with equal compilation settings may share one, the same rule
  // TypeScript's language service applies through its document registry.
  const registry = ts.createDocumentRegistry();
  const sourceFiles = new Map<string, ts.SourceFile>();
  for (const [configPath, files] of projects) {
    const config = configPath
      ? ts.getParsedCommandLineOfConfigFile(
          configPath,
          {},
          {
            ...ts.sys,
            onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
              throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
            },
          },
        )
      : undefined;
    if (config?.errors.length) {
      throw new Error(
        config.errors
          .map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n"))
          .join("\n"),
      );
    }
    const compilerOptions = {
      module: ts.ModuleKind.NodeNext,
      allowJs: true,
      ...config?.options,
      noEmit: true,
    };
    const settings = registry.getKeyForCompilationSettings(compilerOptions);
    const host = ts.createCompilerHost(compilerOptions);
    const parse = host.getSourceFile;
    host.getSourceFile = (fileName, version, ...rest) => {
      // The same file parses differently as ESM and CommonJS.
      const format = typeof version === "object" ? version.impliedNodeFormat : version;
      const key = `${settings}|${format}|${fileName}`;
      const source = sourceFiles.get(key) ?? parse(fileName, version, ...rest);
      if (source) sourceFiles.set(key, source);
      return source;
    };
    const program = ts.createProgram(
      [...files].map((file) => NodePath.resolve(options.cwd, file)),
      compilerOptions,
      host,
    );
    const checker = program.getTypeChecker();
    for (const filePath of files) {
      const source = program.getSourceFile(NodePath.resolve(options.cwd, filePath));
      const module = source && checker.getSymbolAtLocation(source);
      if (!source || !module) continue;
      // Resolving a type is the expensive part, so resolve only reported names.
      // A name can be reported under more than one category.
      const resolveIsSchema = (name: string) => {
        const symbol = checker.tryGetMemberInModuleExports(name, module);
        if (!symbol) return false;
        const exported =
          symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
        const target =
          exported.flags & ts.SymbolFlags.Value
            ? exported
            : checker.resolveName(name, source, ts.SymbolFlags.Value, false);
        if (!target) return false;
        const type = checker.getTypeOfSymbolAtLocation(target, target.valueDeclaration ?? source);
        const marker = type.getProperty(schemaTypeId);
        if (!marker) return false;
        const markerType = checker.getTypeOfSymbolAtLocation(marker, source);
        return markerType.isStringLiteral() && markerType.value === schemaTypeId;
      };
      const schemas = new Map<string, boolean>();
      const isSchema = (name: string) => {
        const result = schemas.get(name) ?? resolveIsSchema(name);
        schemas.set(name, result);
        return result;
      };
      for (const category of categories) {
        const issues = options.issues[category][filePath];
        if (!issues) continue;
        for (const [key, issue] of Object.entries(issues)) {
          const symbols = issue.symbols ?? [{ symbol: issue.symbol }];
          if (symbols.length > 0 && symbols.every(({ symbol }) => isSchema(symbol))) {
            delete issues[key];
            options.counters[category]--;
          }
        }
        if (Object.keys(issues).length === 0) delete options.issues[category][filePath];
      }
    }
  }
  return options;
};

export default preprocess;
