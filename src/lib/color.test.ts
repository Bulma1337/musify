import { dominantColor, pickHeaderColor } from "./color";

const http = vi.hoisted(() => ({ httpRequest: vi.fn() }));
vi.mock("@/api/http", () => http);

function solid(r: number, g: number, b: number, count = 64): Uint8ClampedArray {
  const data = new Uint8ClampedArray(count * 4);
  for (let i = 0; i < count; i++) data.set([r, g, b, 255], i * 4);
  return data;
}

describe("pickHeaderColor", () => {
  it("keeps the hue of a colorful image and darkens it for headers", () => {
    const color = pickHeaderColor(solid(220, 40, 40))!;
    expect(color.r).toBeGreaterThan(color.g * 2);
    expect(color.r).toBeLessThan(220);
  });

  it("prefers colorful pixels over large black areas", () => {
    const data = new Uint8ClampedArray([...solid(0, 0, 0, 60), ...solid(40, 90, 220, 20)]);
    const color = pickHeaderColor(data)!;
    expect(color.b).toBeGreaterThan(color.r);
  });

  it("returns null for fully transparent images", () => {
    expect(pickHeaderColor(new Uint8ClampedArray(16))).toBeNull();
  });
});

describe("dominantColor", () => {
  it("tries a failed image again instead of remembering the failure", async () => {
    http.httpRequest.mockRejectedValueOnce(new Error("timeout"));
    expect(await dominantColor("https://srv/cover/1")).toBeNull();
    // Second call: a new request (which fails differently here: jsdom cannot decode images).
    http.httpRequest.mockResolvedValueOnce(new Response(null, { status: 404 }));
    expect(await dominantColor("https://srv/cover/1")).toBeNull();
    expect(http.httpRequest).toHaveBeenCalledTimes(2);
  });
});
