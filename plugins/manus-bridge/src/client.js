const normalizeBaseUrl = (value) => value.replace(/\/+$/, "");

async function readJson(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

export function createManusClient(apiBaseUrl, fetchImpl = fetch) {
  const baseUrl = normalizeBaseUrl(apiBaseUrl);

  async function request(method, pathname, body) {
    const response = await fetchImpl(`${baseUrl}${pathname}`, {
      method,
      headers: {
        "content-type": "application/json"
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const payload = await readJson(response);

    if (!response.ok) {
      const message =
        payload && typeof payload.error === "string"
          ? payload.error
          : `Manus API request failed: HTTP ${response.status}`;
      throw new Error(message);
    }

    return payload;
  }

  return {
    submitTask(input) {
      return request("POST", "/tasks", input);
    },
    getTask(taskId) {
      return request("GET", `/tasks/${encodeURIComponent(taskId)}`);
    },
    listApprovals(taskId) {
      return request("GET", `/approvals?taskId=${encodeURIComponent(taskId)}`);
    },
    approveTask(approvalId, decisionNote, decidedBy = "manus-bridge") {
      return request("POST", `/approvals/${encodeURIComponent(approvalId)}/approve`, {
        decidedBy,
        ...(typeof decisionNote === "string" && decisionNote.trim()
          ? { decisionNote: decisionNote.trim() }
          : {})
      });
    },
    rejectTask(approvalId, decisionNote, decidedBy = "manus-bridge") {
      return request("POST", `/approvals/${encodeURIComponent(approvalId)}/reject`, {
        decidedBy,
        ...(typeof decisionNote === "string" && decisionNote.trim()
          ? { decisionNote: decisionNote.trim() }
          : {})
      });
    }
  };
}
