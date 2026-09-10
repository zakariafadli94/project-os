const VERSION_ID = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i;

export function createCloudflarePorts(options) {
  const apiBase = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(options.accountId)}/workers/scripts/${encodeURIComponent(options.workerName)}`;

  return {
    async captureBaseDeployment() {
      const response = await options.fetch(new Request(`${apiBase}/deployments`, {
        headers: { authorization: `Bearer ${options.apiToken}` }
      }));
      if (!response.ok) throw new Error(`base deployment capture failed with HTTP ${response.status}`);
      const payload = await response.json();
      const deployments = payload?.result?.deployments ?? payload?.deployments;
      const versions = deployments?.[0]?.versions;
      if (!Array.isArray(versions) || versions.length !== 1 || !VERSION_ID.test(String(versions[0]?.version_id)) || Number(versions[0]?.percentage) !== 100) {
        throw new Error("operator bridge requires one exact 100% base deployment");
      }
      return { version_id: versions[0].version_id, percentage: 100 };
    },
    async restoreBaseDeployment({ versionId }) {
      const response = await options.fetch(new Request(`${apiBase}/deployments?force=true`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.apiToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          strategy: "percentage",
          versions: [{ version_id: versionId, percentage: 100 }],
          annotations: { "workers/message": "Restore sole base after governed operator submission" }
        })
      }));
      if (!response.ok) throw new Error(`base deployment restoration failed with HTTP ${response.status}`);
    }
  };
}

/**
 * Runs exactly one request through a zero-traffic Worker version.
 * All network and Cloudflare operations are injected so this lifecycle can be
 * verified without ever contacting a live deployment during tests.
 */
export async function runOperatorSubmission(input, ports) {
  validateInput(input);

  const base = await ports.captureBaseDeployment();
  if (!base || !VERSION_ID.test(String(base.version_id)) || Number(base.percentage) !== 100) {
    throw new Error("operator bridge requires one exact 100% base deployment");
  }

  const token = ports.generateToken();
  if (typeof token !== "string" || token.length === 0) throw new Error("operator bridge token was not generated");

  let operatorVersionId;
  try {
    operatorVersionId = await ports.createOperatorVersion({ token });
    if (!VERSION_ID.test(String(operatorVersionId))) throw new Error("operator bridge returned an invalid version id");

    await ports.attachZeroTrafficVersion({
      baseVersionId: base.version_id,
      operatorVersionId
    });
    await requireHealth(ports, undefined, base.version_id, "normal traffic left the base version");
    await requireHealth(ports, operatorVersionId, operatorVersionId, "version override did not reach the operator version");

    const context = await ports.fetchContext({
      projectId: input.project_id,
      token,
      operatorVersionId
    });
    if (!context || context.project_id !== input.project_id) throw new Error("operator bridge received invalid mutation context");

    const receipt = await ports.submit({
      kind: input.kind,
      projectId: input.project_id,
      request: input.request,
      context,
      token,
      operatorVersionId
    });
    if (receipt?.status !== "committed" || receipt.project_id !== input.project_id) {
      throw new Error("operator bridge requires a matching committed receipt");
    }

    return {
      status: receipt.status,
      project_id: receipt.project_id,
      request_id: receipt.request_id,
      base_version_id: base.version_id
    };
  } finally {
    if (operatorVersionId) {
      await ports.restoreBaseDeployment({ versionId: base.version_id });
      await requireHealth(ports, undefined, base.version_id, "base restoration did not restore normal traffic");
      await requireHealth(ports, operatorVersionId, base.version_id, "operator version override remained active after restoration");
      const status = await ports.tokenStatusOnBase({ token });
      if (status !== 401) throw new Error("operator credential remained valid on base traffic");
    }
  }
}

function validateInput(input) {
  if (!input || typeof input !== "object") throw new Error("operator input must be an object");
  const unknownKeys = Object.keys(input).filter((key) => !["kind", "project_id", "request"].includes(key));
  if (unknownKeys.length > 0) throw new Error("operator input contains unknown fields");
  if (!["transaction", "document", "artifact"].includes(input.kind)) throw new Error("operator input kind is invalid");
  if (!/^PRJ-\d{4}$/.test(String(input.project_id))) throw new Error("operator input project_id is invalid");
  if (typeof input.request !== "string" || input.request.length === 0 || Buffer.byteLength(input.request) > 256 * 1024) {
    throw new Error("operator input request must be a non-empty string at most 256 KiB");
  }
}

async function requireHealth(ports, overrideVersionId, expectedVersionId, message) {
  const health = await ports.health({ overrideVersionId });
  if (health?.status !== "ok" || health.worker_version_id !== expectedVersionId) throw new Error(message);
}
