/** HTTP 200 alone is not evidence that an MCP operation succeeded. */
export function successfulMcpResult(payload, expectedId) {
  const messages = typeof payload === "string"
    ? payload.split(/\r?\n\r?\n/).flatMap(event => {
      const data = event.split(/\r?\n/).filter(line => line.startsWith("data:"))
        .map(line => line.slice(5).trimStart()).join("\n");
      if (!data) return [];
      try { return [JSON.parse(data)]; } catch { return []; }
    }) : [payload];
  const matches = messages.filter(message => message?.jsonrpc === "2.0" && message.id === expectedId);
  if (matches.length !== 1 || matches[0].error || !matches[0].result
    || typeof matches[0].result !== "object" || Array.isArray(matches[0].result)
    || matches[0].result.isError === true) {
    throw new Error("Control Tower MCP qualification did not return one successful matching result");
  }
  return matches[0].result;
}
