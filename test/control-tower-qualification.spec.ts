import { describe, expect, it } from "vitest";
import { requireGovernedNavigationTool, requireLiveQualificationToken, successfulMcpResult } from "../scripts/control-tower-qualification.mjs";

describe("Control Tower qualification evidence", () => {
  it("rejects a live qualification without an authentication token", () => {
    expect(() => requireLiveQualificationToken(true, undefined)).toThrow();
    expect(() => requireLiveQualificationToken(true, "")).toThrow();
    expect(() => requireLiveQualificationToken(false, undefined)).not.toThrow();
    expect(() => requireLiveQualificationToken(true, "test-token")).not.toThrow();
  });

  it("requires the exact governed navigation variant and its required fields", () => {
    const schema = (required: string[], operation = "navigation.reconcile") => [{
      name: "project_os_write_working_document",
      inputSchema: { type: "object", properties: { request: { anyOf: [{
        type: "object", properties: {
          operation: { const: operation }, expected_generation: { type: "integer" }, expected_index: { type: "object" }
        }, required
      }] } } }
    }];
    expect(() => requireGovernedNavigationTool(schema(["operation", "expected_generation", "expected_index"]))).not.toThrow();
    expect(() => requireGovernedNavigationTool(schema(["operation", "expected_generation"]))).toThrow();
    expect(() => requireGovernedNavigationTool(schema(["operation", "expected_index"]))).toThrow();
    expect(() => requireGovernedNavigationTool(schema(["operation", "expected_generation", "expected_index"], "working.write"))).toThrow();
    expect(() => requireGovernedNavigationTool([{ name: "project_os_write_working_document", inputSchema: {
      description: "navigation.reconcile expected_generation expected_index"
    } }])).toThrow();
  });
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
