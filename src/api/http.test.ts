import { normalizeServerUrl, redactUrl } from "./http";

describe("normalizeServerUrl", () => {
  it("adds https and strips trailing slashes", () => {
    expect(normalizeServerUrl("music.example.com/")).toBe("https://music.example.com");
  });

  it("keeps explicit http, ports and sub paths", () => {
    expect(normalizeServerUrl(" http://192.168.1.5:4533/navidrome// ")).toBe(
      "http://192.168.1.5:4533/navidrome",
    );
  });
});

describe("redactUrl", () => {
  it("hides Subsonic token and salt", () => {
    const redacted = redactUrl("https://x.test/rest/ping?u=bob&t=abc&s=def&v=1.16.1");
    expect(redacted).not.toContain("abc");
    expect(redacted).not.toContain("def");
    expect(redacted).toContain("u=bob");
  });

  it("hides API keys", () => {
    expect(redactUrl("https://x.test/rest/ping?apiKey=secret")).not.toContain("secret");
  });
});
