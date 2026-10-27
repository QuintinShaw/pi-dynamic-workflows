import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type CommandOwner = "builtin" | "saved";

type CommandOwners = Map<string, CommandOwner>;
type RegistryCarrier = { [commandOwnersKey]?: CommandOwners };

const commandOwnersKey = Symbol.for("pi-dynamic-workflows.command-owners");
const fallbackRegistries = new WeakMap<object, CommandOwners>();

/**
 * Pi's built-in slash commands are not part of ExtensionAPI.getCommands().
 * Keep this explicit compatibility set until Pi exposes that host namespace
 * through a supported public SDK API. The first 24 names match the Pi 1.4.0
 * SDK baseline (dist/core/slash-commands.js); the final three are interactive
 * direct handlers in dist/modes/interactive/interactive-mode.js and are not
 * included in that public-list module.
 */
export const PI_RESERVED_COMMAND_NAMES: Set<string> = new Set([
  "settings",
  "model",
  "tree",
  "thinking",
  "scoped-models",
  "export",
  "import",
  "share",
  "bug",
  "copy",
  "name",
  "session",
  "changelog",
  "hotkeys",
  "fork",
  "clone",
  "trust",
  "login",
  "logout",
  "new",
  "compact",
  "reload",
  "resume",
  "quit",
  "debug",
  "arminsayshi",
  "dementedelves",
] as const);

export function isPiReservedCommandName(name: string): boolean {
  return PI_RESERVED_COMMAND_NAMES.has(name);
}

function registryFor(pi: ExtensionAPI): CommandOwners {
  const carrier = pi as unknown as RegistryCarrier;
  const existing = carrier[commandOwnersKey];
  if (existing) return existing;

  const registry: CommandOwners = new Map();
  try {
    Object.defineProperty(carrier, commandOwnersKey, {
      configurable: false,
      enumerable: false,
      value: registry,
      writable: false,
    });
    return registry;
  } catch {
    // A frozen or host-provided API object cannot carry the reload-stable symbol;
    // retain ownership for the lifetime of this API object as a safe fallback.
    const fallback = fallbackRegistries.get(pi as object);
    if (fallback) return fallback;
    fallbackRegistries.set(pi as object, registry);
    return registry;
  }
}

export function isCommandRegistered(pi: ExtensionAPI, name: string): boolean {
  // getCommands() intentionally omits Pi's own slash commands on current
  // hosts, so include the compatibility namespace in the shared registry
  // predicate used by all command registration paths.
  if (isPiReservedCommandName(name)) return true;
  try {
    return (pi.getCommands?.() ?? []).some((command: { name: string }) => command.name === name);
  } catch {
    return false;
  }
}

export function commandOwner(pi: ExtensionAPI, name: string): CommandOwner | undefined {
  return registryFor(pi).get(name);
}

/** Claim a command only after this extension has successfully registered it. */
export function claimCommand(pi: ExtensionAPI, name: string, owner: CommandOwner): boolean {
  // A host-reserved name must never become extension-owned metadata. Otherwise
  // a later saved-workflow availability check could mistake it for a valid
  // same-owner shadow and bypass the host namespace guard.
  if (isPiReservedCommandName(name)) return false;
  const registry = registryFor(pi);
  const current = registry.get(name);
  if (current && current !== owner) return false;
  registry.set(name, owner);
  return true;
}
