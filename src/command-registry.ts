import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type CommandOwner = "builtin" | "saved";

type CommandOwners = Map<string, CommandOwner>;
type RegistryCarrier = { [commandOwnersKey]?: CommandOwners };

const commandOwnersKey = Symbol.for("pi-dynamic-workflows.command-owners");
const fallbackRegistries = new WeakMap<object, CommandOwners>();

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
  const registry = registryFor(pi);
  const current = registry.get(name);
  if (current && current !== owner) return false;
  registry.set(name, owner);
  return true;
}
