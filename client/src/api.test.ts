import { afterEach, describe, expect, it, vi } from "vitest";
import { api, encodeMetadataHeaderValue } from "./api";

afterEach(() => vi.unstubAllGlobals());

describe("Workbench HTTP metadata", () => {
  it("encodes Unicode metadata as an ASCII-only header value", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({ data: { ok: true } }),
      { status: 200, headers: { "content-type": "application/json" } }
    ));
    vi.stubGlobal("fetch", fetchMock);

    await api("/api/example", {
      method: "POST",
      body: JSON.stringify({}),
      headers: {
        "x-multi-agent-source": "workbench",
        "x-multi-agent-source-label": "直接交办调试台"
      }
    });

    const init = fetchMock.mock.calls[0]?.[1];
    const headers = init?.headers as Headers;
    expect(headers.get("x-multi-agent-source")).toBe("workbench");
    expect(headers.get("x-multi-agent-source-label")).toBe(`utf8:${encodeURIComponent("直接交办调试台")}`);
  });

  it("leaves existing ASCII metadata unchanged", () => {
    expect(encodeMetadataHeaderValue("MCP conversation")).toBe("MCP conversation");
  });
});
