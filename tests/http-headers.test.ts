import { describe, expect, it } from "vitest";
import { decodeUtf8HeaderValue } from "../src/core/httpHeaders.js";

describe("UTF-8 HTTP metadata", () => {
  it("decodes explicitly encoded metadata", () => {
    expect(decodeUtf8HeaderValue(`utf8:${encodeURIComponent("小狐整体档案设计")}`)).toBe("小狐整体档案设计");
  });

  it("repairs UTF-8 bytes previously interpreted as Latin-1", () => {
    const mojibake = Buffer.from("小狐整体档案设计", "utf8").toString("latin1");
    expect(decodeUtf8HeaderValue(mojibake)).toBe("小狐整体档案设计");
  });

  it("does not alter ASCII, valid Latin-1, or malformed encoded values", () => {
    expect(decodeUtf8HeaderValue("outside-project")).toBe("outside-project");
    expect(decodeUtf8HeaderValue("Jos\u00e9")).toBe("Jos\u00e9");
    expect(decodeUtf8HeaderValue("utf8:%E5%ZZ")).toBe("utf8:%E5%ZZ");
  });
});
