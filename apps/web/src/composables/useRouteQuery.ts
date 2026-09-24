import { nextTick, watch, type Ref } from "vue";
import { useRoute, type LocationQueryRaw } from "vue-router";
import { router } from "../router";

export type QueryCodec<T> = {
  defaultValue: T;
  /** Returns undefined for values that are not valid for this key. */
  parse: (raw: string) => T | undefined;
  serialize: (value: T) => string;
};

export function stringQuery(defaultValue = ""): QueryCodec<string> {
  return { defaultValue, parse: (raw) => raw, serialize: (value) => value };
}

export function enumQuery<T extends string | number>(values: readonly T[], defaultValue: T): QueryCodec<T> {
  return {
    defaultValue,
    parse: (raw) => values.find((value) => String(value) === raw),
    serialize: (value) => String(value),
  };
}

export function pageQuery(): QueryCodec<number> {
  return {
    defaultValue: 1,
    parse: (raw) => (/^\d+$/.test(raw) && Number(raw) >= 1 ? Number(raw) : undefined),
    serialize: (value) => String(value),
  };
}

let pending: Record<string, string | undefined> | null = null;

/** Coalesces all query writes made in one tick into a single router.replace. */
function scheduleQueryWrite(key: string, value: string | undefined): void {
  if (!pending) {
    pending = {};
    void nextTick(() => {
      const changes = pending ?? {};
      pending = null;
      const query: LocationQueryRaw = { ...router.currentRoute.value.query };
      for (const [name, next] of Object.entries(changes)) {
        if (next === undefined) {
          delete query[name];
        } else {
          query[name] = next;
        }
      }
      void router.replace({ query });
    });
  }
  pending[key] = value;
}

/**
 * Two-way binding between a state ref and one URL query key. Default values are omitted from the
 * URL. The URL wins on setup (deep links); state changes write back with replace(); back/forward
 * navigation updates the state.
 */
export function useRouteQuery<T>(key: string, state: Ref<T>, codec: QueryCodec<T>): void {
  const route = useRoute();
  const routeName = route.name;

  function fromUrl(): T {
    const raw = route.query[key];
    return (typeof raw === "string" ? codec.parse(raw) : undefined) ?? codec.defaultValue;
  }

  function toUrl(value: T): string | undefined {
    const serialized = codec.serialize(value);
    return serialized === codec.serialize(codec.defaultValue) ? undefined : serialized;
  }

  function currentRaw(): string | undefined {
    const raw = route.query[key];
    return typeof raw === "string" ? raw : undefined;
  }

  state.value = fromUrl();

  watch(state, (value) => {
    const next = toUrl(value);
    if (next !== currentRaw()) {
      scheduleQueryWrite(key, next);
    }
  });

  watch(
    () => route.query[key],
    () => {
      if (route.name !== routeName) {
        return;
      }
      const next = fromUrl();
      if (codec.serialize(next) !== codec.serialize(state.value)) {
        state.value = next;
      }
    },
  );
}
