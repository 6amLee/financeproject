import { describe, it, expect, vi } from "vitest";

// Stub the Anthropic SDK so nothing in this file can make a network request.
const mockCreate = vi.fn(async () => ({
  content: [{ type: "text", text: '{"stubbed":true}' }],
}));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class FakeAnthropic {
    constructor() {
      this.messages = { create: mockCreate };
    }
  },
}));

const { buildContentBlocks, extractReceiptData, RECEIPT_PROMPT } = await import(
  "../src/claude.js"
);

describe("buildContentBlocks", () => {
  it("builds a document block for PDFs", () => {
    const blocks = buildContentBlocks({
      mimeType: "application/pdf",
      base64Data: "UERGREFUQQ==",
    });
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: "UERGREFUQQ==",
      },
    });
    expect(blocks[1]).toEqual({ type: "text", text: RECEIPT_PROMPT });
  });

  it.each(["image/jpeg", "image/png", "image/gif", "image/webp"])(
    "builds an image block for %s",
    (mimeType) => {
      const blocks = buildContentBlocks({ mimeType, base64Data: "SU1BR0U=" });
      expect(blocks).toHaveLength(2);
      expect(blocks[0]).toEqual({
        type: "image",
        source: { type: "base64", media_type: mimeType, data: "SU1BR0U=" },
      });
      expect(blocks[1]).toEqual({ type: "text", text: RECEIPT_PROMPT });
    }
  );

  it("builds a single text block for body-only emails (Branch B)", () => {
    const blocks = buildContentBlocks({
      textBody: "Your LinkedIn receipt: $99.00 charged on 2026-07-01",
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("text");
    expect(blocks[0].text).toContain(RECEIPT_PROMPT);
    expect(blocks[0].text).toContain("Your LinkedIn receipt: $99.00");
  });

  it("falls back to the text body when the attachment mimeType is unsupported", () => {
    const blocks = buildContentBlocks({
      mimeType: "application/zip",
      base64Data: "WklQ",
      textBody: "receipt text",
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("text");
  });

  it("throws when there is nothing to extract from", () => {
    expect(() =>
      buildContentBlocks({ mimeType: "application/zip", base64Data: "WklQ" })
    ).toThrow(/nothing to extract/);
  });
});

describe("extractReceiptData", () => {
  it("calls the (mocked) SDK with the right model and returns the text block", async () => {
    const result = await extractReceiptData({
      mimeType: "application/pdf",
      base64Data: "UERGREFUQQ==",
    });
    expect(result).toBe('{"stubbed":true}');
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const call = mockCreate.mock.calls[0][0];
    expect(call.model).toBe("claude-haiku-4-5");
    expect(call.max_tokens).toBe(1024);
    expect(call.messages[0].content[0].type).toBe("document");
  });
});
