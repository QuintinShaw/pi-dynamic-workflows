const UNSAFE_JSON_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface JsonTreePrototypes {
  arrayPrototype: object;
  objectPrototype: object;
}

const HOST_PROTOTYPES: JsonTreePrototypes = {
  arrayPrototype: Array.prototype,
  objectPrototype: Object.prototype,
};

/**
 * Clone a value into the exact tree semantics preserved by JSON persistence.
 * Repeated references are cloned independently, matching JSON.stringify/parse;
 * cycles, custom prototypes, toJSON hooks, accessors, sparse arrays, and lossy
 * scalar values are rejected instead of being silently changed.
 */
export function normalizeJsonTree(value: unknown, prototypes: JsonTreePrototypes = HOST_PROTOTYPES): JsonValue {
  return normalizeValue(value, prototypes, new WeakSet<object>(), false);
}

/** Normalize workflow child arguments using JSON.stringify's object-property omission semantics. */
export function normalizeJsonChildArgs(value: unknown, prototypes: JsonTreePrototypes = HOST_PROTOTYPES): JsonValue {
  return normalizeValue(value, prototypes, new WeakSet<object>(), true);
}

/** Snapshot a result exactly as JSON object persistence represents it. */
export function normalizeJsonResult(value: unknown, prototypes: JsonTreePrototypes = HOST_PROTOTYPES): JsonValue {
  return normalizeJsonChildArgs(value, prototypes);
}

function normalizeValue(
  value: unknown,
  prototypes: JsonTreePrototypes,
  ancestors: WeakSet<object>,
  omitUndefinedProperties: boolean,
): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite numbers are not JSON values");
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") throw new TypeError(`${typeof value} is not a JSON value`);
  if (ancestors.has(value)) throw new TypeError("cyclic references are not JSON values");
  if ("toJSON" in value) throw new TypeError("toJSON hooks are not JSON values");

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const arrayPrototype = Object.getPrototypeOf(value);
      if (arrayPrototype !== prototypes.arrayPrototype && arrayPrototype !== HOST_PROTOTYPES.arrayPrototype) {
        throw new TypeError("custom array prototypes are not JSON values");
      }
      const keys = Reflect.ownKeys(value).filter((key) => key !== "length");
      if (keys.length !== value.length) throw new TypeError("sparse arrays are not JSON values");
      const normalized: JsonValue[] = [];
      for (let index = 0; index < value.length; index++) {
        const key = String(index);
        if (!Object.hasOwn(value, key)) throw new TypeError("sparse arrays are not JSON values");
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !("value" in descriptor)) {
          throw new TypeError("array accessors and hidden entries are not JSON values");
        }
        normalized.push(normalizeValue(descriptor.value, prototypes, ancestors, omitUndefinedProperties));
      }
      return normalized;
    }

    const prototype = Object.getPrototypeOf(value);
    if (
      prototype !== prototypes.objectPrototype &&
      prototype !== HOST_PROTOTYPES.objectPrototype &&
      prototype !== null
    ) {
      throw new TypeError("custom prototypes are not JSON values");
    }
    const normalized: Record<string, JsonValue> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string" || UNSAFE_JSON_KEYS.has(key)) {
        throw new TypeError("unsafe object keys are not JSON values");
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        throw new TypeError("object accessors and hidden properties are not JSON values");
      }
      if (omitUndefinedProperties && descriptor.value === undefined) continue;
      normalized[key] = normalizeValue(descriptor.value, prototypes, ancestors, omitUndefinedProperties);
    }
    return normalized;
  } finally {
    ancestors.delete(value);
  }
}
