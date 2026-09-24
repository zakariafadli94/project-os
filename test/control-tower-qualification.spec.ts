import { describe, expect, it } from "vitest";
import { successfulMcpResult } from "../scripts/control-tower-qualification.mjs";

describe("Control Tower qualification evidence", () => {
  it("rejects HTTP-success tool errors and JSON-RPC errors", () => {
    expect(() => successfulMcpResult({ jsonrpc: "2.0", id: 3, result: { isError: true, content: [] } }, 3)).toThrow();
    expect(() => successfulMcpResult({ jsonrpc: "2.0", id: 3, error: { code: -32603, message: "private" } }, 3)).toThrow();
  });
  it("accepts only the expected JSON-RPC response, including SSE framing", () => {
    const response = { jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: "{}" }] } };
    expect(successfulMcpResult(response, 3)).toEqual(response.result);
    expect(successfulMcpResult(`event: message\ndata: ${JSON.stringify(response)}\n\n`, 3)).toEqual(response.result);
    expect(() => successfulMcpResult(response, 4)).toThrow();
    expect(() => successfulMcpResult("not a response", 3)).toThrow();
  });
});
