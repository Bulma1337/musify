import { toast, toastError, useToasts } from "./toast";

describe("toasts", () => {
  beforeEach(() => useToasts.setState({ toasts: [] }));

  it("shows a repeating message only once", () => {
    for (let i = 0; i < 5; i++) toastError("Playback error: unsupported format");
    expect(useToasts.getState().toasts).toHaveLength(1);
    toast("Playback error: unsupported format");
    toastError("Something else");
    expect(useToasts.getState().toasts.map((t) => t.tone)).toEqual(["error", "info", "error"]);
  });
});
