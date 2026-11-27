import { computed, inject, type ComputedRef, type InjectionKey } from "vue";

export const fieldDescriptionKey: InjectionKey<ComputedRef<string | undefined>> = Symbol("ui-field-description");

export function useFieldDescription(): ComputedRef<string | undefined> {
  return inject(
    fieldDescriptionKey,
    computed(() => undefined),
  );
}
