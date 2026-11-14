import { computed, inject, type ComputedRef, type InjectionKey } from "vue";

/** Id of the hint or error that UiField shows under its control, for the control's aria-describedby. */
export const fieldDescriptionKey: InjectionKey<ComputedRef<string | undefined>> = Symbol("ui-field-description");

/** The enclosing UiField's hint/error id, or undefined outside a field or when the field shows neither. */
export function useFieldDescription(): ComputedRef<string | undefined> {
  return inject(
    fieldDescriptionKey,
    computed(() => undefined),
  );
}
