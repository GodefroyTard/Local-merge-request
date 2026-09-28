export class UsageError extends Error {}

export interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string[]>;
}

const BOOLEAN_FLAGS = new Set(["json", "all", "yes", "help"]);

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();
  const add = (name: string, value: string) => flags.set(name, [...(flags.get(name) ?? []), value]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg === "-h") {
      add("help", "true");
    } else if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
      if (BOOLEAN_FLAGS.has(name)) {
        if (eq >= 0) throw new UsageError(`--${name} takes no value`);
        add(name, "true");
      } else if (eq >= 0) {
        add(name, arg.slice(eq + 1));
      } else {
        const value = argv[++i];
        if (value === undefined) throw new UsageError(`--${name} expects a value`);
        add(name, value);
      }
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, flags };
}

export function flag(args: ParsedArgs, name: string): string | undefined {
  const values = args.flags.get(name);
  return values?.[values.length - 1];
}

export function hasFlag(args: ParsedArgs, name: string): boolean {
  return args.flags.has(name);
}

export function checkFlags(args: ParsedArgs, allowed: string[]): void {
  for (const name of args.flags.keys()) {
    if (!allowed.includes(name)) throw new UsageError(`unknown option --${name}`);
  }
}
