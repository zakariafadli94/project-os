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

export function requireLiveQualificationToken(requireLive, token) {
  if (requireLive && !token) throw new Error("Control Tower live qualification token is unavailable");
}

/** Require callable schema fields, not words embedded in a tool description. */
export function requireGovernedNavigationTool(tools) {
  const documentTool = Array.isArray(tools)
    ? tools.find(tool => tool?.name === "project_os_write_working_document") : null;
  let qualified = false;
  const visit = node => {
    if (!node || typeof node !== "object" || qualified) return;
    const operation = node.properties?.operation;
    const isNavigation = operation?.const === "navigation.reconcile"
      || (Array.isArray(operation?.enum) && operation.enum.length === 1 && operation.enum[0] === "navigation.reconcile");
    if (isNavigation && node.properties?.expected_generation && node.properties?.expected_index
      && Array.isArray(node.required) && ["operation", "expected_generation", "expected_index"].every(field => node.required.includes(field))) {
      qualified = true;
      return;
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") visit(value);
    }
  };
  visit(documentTool?.inputSchema?.properties?.request);
  if (!qualified) throw new Error("authenticated tools/list omitted governed navigation.reconcile inputs");
}
