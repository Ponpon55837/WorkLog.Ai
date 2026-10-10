import { afterEach, describe, expect, it, vi } from "vitest";
import { useToast } from "../../apps/web/src/composables/useToast.js";
import { createStoreHarness } from "./helpers/store-harness.js";
let harness: ReturnType<typeof createStoreHarness>;
afterEach(async () => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await harness?.cleanup();
});
describe("clipboard feedback", () => {
  it("returns actual success and never reports a rejected write as copied", async () => {
    harness = createStoreHarness(() => ({}));
    vi.useFakeTimers();
    vi.stubGlobal("window", { setTimeout });
    const writeText = vi.fn().mockRejectedValue(new Error("Fictional rejection"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const toast = useToast();
    expect(await toast.copyWithToast("Fictional snapshot", "Fictional success")).toBe(false);
    expect(toast.toasts.value.at(-1)?.tone).toBe("danger");
    writeText.mockResolvedValue(undefined);
    expect(await toast.copyWithToast("Fictional snapshot", "Fictional success")).toBe(true);
    expect(writeText).toHaveBeenLastCalledWith("Fictional snapshot");
    expect(toast.toasts.value.at(-1)?.tone).toBe("success");
  });
});
