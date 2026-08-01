import Flow from "../models/Flow.js";
import WhatsAppSession from "../models/WhatsAppSession.js";
import WhatsAppService from "../services/WhatsAppService.js";
import UserGoogleConnection from "../models/UserGoogleConnection.js";

// In-memory runtime state for conversations waiting on an Input node reply.
const pendingInputState = new Map();

function runtimeKey(runtimeSessionId, userId, phoneNumber) {
  return [
    String(runtimeSessionId || ""),
    String(userId || ""),
    String(phoneNumber || ""),
  ].join("::");
}

// Check trigger and execute flow
export const executeFlowOnMessage = async (
  runtimeSessionId,
  phoneNumber,
  messageContent,
  userId,
) => {
  try {
    const key = runtimeKey(runtimeSessionId, userId, phoneNumber);
    const waitingState = pendingInputState.get(key);

    // If this chat is waiting for an input node reply, consume this message as input and resume.
    if (waitingState?.flowId) {
      const waitingFlow = await Flow.findOne({
        _id: waitingState.flowId,
        userId,
        status: "Active",
      });

      if (!waitingFlow) {
        pendingInputState.delete(key);
      } else {
        const resumedContext = {
          ...(waitingState.context || {}),
        };

        applyInputToContext(
          resumedContext,
          waitingState.variableKey,
          messageContent,
          waitingState.splitVariables,
        );

        pendingInputState.delete(key);

        const resumeResult = await executeFlowSequence(waitingFlow, {
          phoneNumber,
          runtimeSessionId,
          context: resumedContext,
          startNodeId: waitingState.nextNodeId,
        });

        if (resumeResult?.status === "waiting") {
          pendingInputState.set(key, {
            flowId: String(waitingFlow._id),
            variableKey: resumeResult.variableKey,
            splitVariables: resumeResult.splitVariables || "",
            nextNodeId: resumeResult.nextNodeId,
            context: resumeResult.context,
            updatedAt: Date.now(),
          });
        }

        return;
      }
    }

    const session = await WhatsAppSession.findOne({
      sessionId: runtimeSessionId,
      userId,
    }).select("_id");

    if (!session) {
      return;
    }

    // Find flows for this session
    const flows = await Flow.find({
      sessionId: session._id,
      userId,
      status: "Active",
    });

    for (const flow of flows) {
      // Find trigger node
      const triggerNode = flow.nodes.find((n) => n.type === "trigger");
      if (!triggerNode) continue;

      // Check if trigger matches
      const triggerMatch = checkTriggerMatch(triggerNode.data, messageContent);
      if (!triggerMatch) continue;

      console.log(`✅ Flow triggered: ${flow.name}`);

      // Execute flow
      const result = await executeFlowSequence(flow, {
        phoneNumber,
        runtimeSessionId,
        context: createRuntimeContext(phoneNumber, messageContent),
      });

      if (result?.status === "waiting") {
        pendingInputState.set(key, {
          flowId: String(flow._id),
          variableKey: result.variableKey,
          splitVariables: result.splitVariables || "",
          nextNodeId: result.nextNodeId,
          context: result.context,
          updatedAt: Date.now(),
        });
      }

      // Process first matching flow only to avoid overlapping runtime states.
      break;
    }
  } catch (error) {
    console.error("Error executing flow on message:", error);
  }
};

// Check if trigger condition matches
function checkTriggerMatch(triggerData, messageContent) {
  const { triggerType, keyword } = triggerData || {};
  const normalizedMessage = String(messageContent || "")
    .trim()
    .toLowerCase();
  const normalizedKeyword = String(keyword || "")
    .trim()
    .toLowerCase();

  if (triggerType === "message_received") {
    return true; // All messages trigger this
  }

  if (triggerType === "keyword_match") {
    if (!normalizedKeyword) return false;
    return normalizedMessage.includes(normalizedKeyword);
  }

  if (triggerType === "match_text") {
    if (!normalizedKeyword) return false;
    return normalizedMessage === normalizedKeyword;
  }

  return false;
}

function hasContextKey(context, key) {
  if (!key) return false;
  return Object.prototype.hasOwnProperty.call(context, key);
}

function resolveTemplate(text, context) {
  return String(text ?? "").replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, rawKey) => {
    const key = String(rawKey || "").trim();
    const value = hasContextKey(context, key) ? context[key] : "";
    return value == null ? "" : String(value);
  });
}

function resolveValue(input, context) {
  const raw = String(input ?? "").trim();
  if (!raw) return "";

  if (hasContextKey(context, raw)) {
    return context[raw];
  }

  const rendered = resolveTemplate(raw, context).trim();
  if (hasContextKey(context, rendered)) {
    return context[rendered];
  }

  return rendered;
}

function toComparable(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === "number" || typeof value === "boolean") return value;

  const text = String(value).trim();
  if (text === "true") return true;
  if (text === "false") return false;
  if (text !== "" && !Number.isNaN(Number(text))) return Number(text);
  return text;
}

function toLowerSafe(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function evaluateRule(rule, context) {
  const operator = rule?.operator || "equals";

  const leftRaw = String(rule?.field ?? "").trim();
  const rightRaw = String(rule?.value ?? "").trim();

  const leftValue = toComparable(
    hasContextKey(context, leftRaw)
      ? context[leftRaw]
      : resolveValue(leftRaw, context),
  );
  const rightValue = toComparable(resolveValue(rightRaw, context));

  const leftText = String(leftValue ?? "");
  const rightText = String(rightValue ?? "");
  const leftLower = leftText.toLowerCase();
  const rightLower = rightText.toLowerCase();

  switch (operator) {
    case "equals":
      return leftLower === rightLower;
    case "not_equals":
      return leftLower !== rightLower;
    case "contains":
      return leftLower.includes(rightLower);
    case "not_contains":
      return !leftLower.includes(rightLower);
    case "starts_with":
      return leftLower.startsWith(rightLower);
    case "ends_with":
      return leftLower.endsWith(rightLower);
    case "gt":
      return Number(leftValue) > Number(rightValue);
    case "lt":
      return Number(leftValue) < Number(rightValue);
    case "gte":
      return Number(leftValue) >= Number(rightValue);
    case "lte":
      return Number(leftValue) <= Number(rightValue);
    case "num_eq":
      return Number(leftValue) === Number(rightValue);
    case "exists":
      return (
        leftValue !== undefined && leftValue !== null && leftText.trim() !== ""
      );
    case "not_exists":
      return (
        leftValue === undefined || leftValue === null || leftText.trim() === ""
      );
    case "is_empty":
      return leftText.trim() === "";
    case "is_not_empty":
      return leftText.trim() !== "";
    case "in_list": {
      const list = rightLower
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      return list.includes(leftLower);
    }
    case "not_in_list": {
      const list = rightLower
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      return !list.includes(leftLower);
    }
    case "regex":
      try {
        return new RegExp(rightText).test(leftText);
      } catch {
        return false;
      }
    default:
      return false;
  }
}

function evaluateConditionNode(conditionNode, context) {
  const data = conditionNode?.data || {};
  const { advancedMode, expression, rules = [], logic = "AND" } = data;

  if (advancedMode && expression) {
    try {
      const renderedExpression = String(expression).replace(
        /\{\{\s*([^}]+?)\s*\}\}/g,
        (_, rawKey) => {
          const key = String(rawKey || "").trim();
          const value = hasContextKey(context, key) ? context[key] : "";
          return JSON.stringify(value ?? "");
        },
      );

      const result = Function(
        `"use strict"; return (${renderedExpression});`,
      )();
      return Boolean(result);
    } catch (error) {
      console.error("Error evaluating advanced condition:", error.message);
      return false;
    }
  }

  const activeRules = Array.isArray(rules) && rules.length > 0 ? rules : [];
  if (activeRules.length === 0) return false;

  const results = activeRules.map((rule) => evaluateRule(rule, context));
  return logic === "OR" ? results.some(Boolean) : results.every(Boolean);
}

function evaluateRouterCase(routerCase, fieldValue, context) {
  const operator = routerCase?.operator || "equals";
  const actual = toLowerSafe(fieldValue);
  const expectedRaw = resolveValue(routerCase?.value || "", context);
  const expected = toLowerSafe(expectedRaw);

  if (operator === "expression") {
    try {
      const expression = String(routerCase?.value || "").replace(
        /\{\{\s*([^}]+?)\s*\}\}/g,
        (_, rawKey) => {
          const key = String(rawKey || "").trim();
          const value = hasContextKey(context, key) ? context[key] : "";
          return JSON.stringify(value ?? "");
        },
      );

      return Boolean(Function(`"use strict"; return (${expression});`)());
    } catch (error) {
      console.error("Error evaluating router expression:", error.message);
      return false;
    }
  }

  if (operator === "contains") {
    return actual.includes(expected);
  }

  if (operator === "starts_with") {
    return actual.startsWith(expected);
  }

  if (operator === "ends_with") {
    return actual.endsWith(expected);
  }

  const values = expected
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  if (values.length > 1) {
    return values.includes(actual);
  }

  return actual === expected;
}

function flattenJson(value, prefix = "", target = {}) {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      flattenJson(item, `${prefix}[${index}]`, target),
    );
    return target;
  }

  if (value && typeof value === "object") {
    Object.entries(value).forEach(([key, nested]) => {
      flattenJson(nested, prefix ? `${prefix}.${key}` : key, target);
    });
    return target;
  }

  if (prefix) {
    target[prefix] = value;
  }
  return target;
}

function createRuntimeContext(phoneNumber, incomingText) {
  const text = String(incomingText ?? "").trim();
  return {
    incoming_message: text,
    user_message: text,
    user_input: text.toLowerCase(),
    "user.message": text,
    "user.reply": text.toLowerCase(),
    "user.phone": String(phoneNumber ?? ""),
    "user.name": "",
    "user.email": "",
  };
}

function getOutgoingEdge(edges, nodeId, sourceHandle) {
  const outgoing = edges.filter((edge) => edge.source === nodeId);
  if (sourceHandle !== undefined && sourceHandle !== null) {
    const matched = outgoing.find(
      (edge) => String(edge.sourceHandle || "") === String(sourceHandle),
    );
    if (matched) return matched;
  }

  return outgoing[0] || null;
}

// Execute flow sequence
async function executeFlowSequence(
  flow,
  { phoneNumber, runtimeSessionId, context, startNodeId = null },
) {
  try {
    const triggerNode = flow.nodes.find((n) => n.type === "trigger");
    if (!triggerNode) return;

    const nodeMap = new Map((flow.nodes || []).map((node) => [node.id, node]));
    const edges = flow.edges || [];

    let currentNode = null;
    if (startNodeId) {
      currentNode = nodeMap.get(startNodeId) || null;
    } else {
      const firstEdge = getOutgoingEdge(edges, triggerNode.id);
      currentNode = firstEdge ? nodeMap.get(firstEdge.target) : null;
    }

    const maxSteps = 100;
    let stepCount = 0;

    while (stepCount < maxSteps && currentNode) {
      stepCount += 1;

      if (currentNode.type === "message") {
        await executeSendMessage(
          currentNode,
          phoneNumber,
          runtimeSessionId,
          context,
        );
      }

      if (currentNode.type === "input") {
        const { variableKey, splitVariables } = await executeInputNode(
          currentNode,
          phoneNumber,
          runtimeSessionId,
          context,
        );
        const edgeAfterInput = getOutgoingEdge(edges, currentNode.id);
        return {
          status: "waiting",
          variableKey,
          splitVariables,
          nextNodeId: edgeAfterInput?.target || null,
          context,
        };
      }

      let nextHandle = null;
      if (currentNode.type === "condition") {
        const result = evaluateConditionNode(currentNode, context);
        nextHandle = result ? "true" : "false";
      } else if (currentNode.type === "router") {
        nextHandle = await executeRouterNode(currentNode, context);
      } else if (currentNode.type === "api") {
        await executeApiNode(currentNode, context);
      } else if (currentNode.type === "googlesheets") {
        await executeGoogleSheetsNode(currentNode, flow.userId, context);
      }

      const edge = getOutgoingEdge(edges, currentNode.id, nextHandle);
      currentNode = edge ? nodeMap.get(edge.target) : null;
    }

    console.log(`✅ Flow execution completed: ${flow.name}`);
    return { status: "completed", context };
  } catch (error) {
    console.error("Error in flow execution:", error);
    return { status: "failed", error: error.message };
  }
}

async function executeInputNode(
  inputNode,
  phoneNumber,
  runtimeSessionId,
  context,
) {
  const promptText = resolveTemplate(
    inputNode?.data?.prompt || "Please enter a value",
    context,
  );

  if (promptText) {
    try {
      await WhatsAppService.sendMessage(
        runtimeSessionId,
        phoneNumber,
        promptText,
      );
      console.log(`📨 Flow input prompt sent to ${phoneNumber}: ${promptText}`);
    } catch (error) {
      console.error("Error sending input prompt:", error.message);
    }
  }

  const variableKey =
    String(inputNode?.data?.variableKey || "user_input").trim() || "user_input";
  const splitVariables = String(inputNode?.data?.splitVariables || "").trim();

  return { variableKey, splitVariables };
}

function applyInputToContext(
  context,
  variableKey,
  incomingText,
  splitVariables = "",
) {
  const key = String(variableKey || "user_input").trim() || "user_input";
  const text = String(incomingText ?? "").trim();
  const normalized = text.toLowerCase();

  context[key] = normalized;
  context.incoming_message = text;
  context.user_message = text;
  context.user_input = normalized;
  context["user.reply"] = normalized;

  // Split comma-separated input into both numeric and named variables.
  // Numeric indices ({{key.0}}, {{key.1}}) are always created for backward compat.
  // Named variables ({{key.name}}, {{key.age}}) are created when splitVariables is set.
  if (text.includes(",")) {
    const parts = text
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    const namedVars = splitVariables
      ? splitVariables
          .split(",")
          .map((v) =>
            v
              .trim()
              .replace(/[^a-z0-9_]/gi, "_")
              .toLowerCase(),
          )
          .filter(Boolean)
      : [];

    parts.forEach((part, i) => {
      context[`${key}.${i}`] = part.toLowerCase();
      context[`${key}.raw.${i}`] = part;
      if (namedVars[i]) {
        context[`${key}.${namedVars[i]}`] = part.toLowerCase();
        context[`${key}.${namedVars[i]}.raw`] = part;
      }
    });
    context[`${key}.count`] = parts.length;
  }
}

async function executeRouterNode(routerNode, context) {
  const cases = Array.isArray(routerNode?.data?.cases)
    ? routerNode.data.cases
    : [];
  const fieldKey =
    String(routerNode?.data?.field || "user_input").trim() || "user_input";
  const fieldValue = resolveValue(fieldKey, context);

  const matched = cases.find((routerCase) =>
    evaluateRouterCase(routerCase, fieldValue, context),
  );
  return matched?.id || "default";
}

async function executeApiNode(apiNode, context) {
  try {
    const {
      method = "GET",
      url = "",
      headers = [],
      params = [],
      body = "",
      responsePrefix = "api",
    } = apiNode.data || {};

    const resolvedUrl = resolveTemplate(url, context);
    if (!resolvedUrl) {
      console.warn("API node skipped: URL is empty");
      return;
    }

    const urlObject = new URL(resolvedUrl);
    (params || []).forEach(({ key, value }) => {
      if (!key) return;
      urlObject.searchParams.set(
        resolveTemplate(key, context),
        resolveTemplate(value, context),
      );
    });

    const headerObject = {};
    (headers || []).forEach(({ key, value }) => {
      if (!key) return;
      headerObject[resolveTemplate(key, context)] = resolveTemplate(
        value,
        context,
      );
    });

    const requestOptions = { method, headers: headerObject };
    if (
      ["POST", "PUT", "PATCH"].includes(method) &&
      String(body || "").trim()
    ) {
      requestOptions.body = resolveTemplate(body, context);
    }

    const response = await fetch(urlObject.toString(), requestOptions);
    const contentType = response.headers.get("content-type") || "";
    const payload = contentType.includes("application/json")
      ? await response.json()
      : await response.text();

    if (!response.ok) {
      throw new Error(
        typeof payload === "string" ? payload : JSON.stringify(payload),
      );
    }

    const flattened = flattenJson(payload, responsePrefix || "api", {});
    Object.entries(flattened).forEach(([key, value]) => {
      context[key] = value;
    });
  } catch (error) {
    console.error("Error in executeApiNode:", error.message);
  }
}

// ── Google Sheets Node ────────────────────────────────────────────────────────

async function executeGoogleSheetsNode(sheetsNode, flowUserId, context) {
  const d = sheetsNode.data || {};
  const prefix = d.outputPrefix || "sheets";

  // Helper: set failure state and return
  const fail = (msg) => {
    context[`${prefix}.success`] = false;
    context[`${prefix}.error`] = msg;
    console.warn(`[GoogleSheets] ${msg}`);
  };

  try {
    // 1. Get flow-owner's saved Google OAuth token
    const conn = await UserGoogleConnection.findOne({ userId: flowUserId })
      .select("+accessToken")
      .lean();

    if (!conn?.accessToken) {
      return fail(
        "Google Sheets not connected. Open the flow in builder and connect.",
      );
    }

    const now = new Date();
    if (conn.expiresAt && new Date(conn.expiresAt) < now) {
      return fail(
        "Google OAuth token has expired. Re-connect in the Flow Builder.",
      );
    }

    const token = conn.accessToken;
    const spreadsheetId = d.spreadsheetId;
    const sheetName = d.sheetName || "Sheet1";
    const action = d.action || "read";

    if (!spreadsheetId)
      return fail("No spreadsheet configured in Google Sheets node.");

    const BASE = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`;

    // Sheets API fetch helper
    async function gFetch(url, method = "GET", body = null) {
      const opts = {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      };
      if (body) opts.body = JSON.stringify(body);
      const res = await fetch(url, opts);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error?.message || `HTTP ${res.status}`);
      return data;
    }

    // Column letter → 0-based index  (A→0, B→1 …)
    function ci(col) {
      return (
        String(col || "A")
          .toUpperCase()
          .trim()
          .charCodeAt(0) - 65
      );
    }

    // Read all values from a range
    async function readRows(range) {
      const data = await gFetch(
        `${BASE}/values/${encodeURIComponent(sheetName + "!" + range)}`,
      );
      return data.values || [];
    }

    // ── READ ──────────────────────────────────────────────────────────────────
    if (action === "read") {
      const range = d.readRange || "A:Z";
      const filterCol = resolveTemplate(d.readFilterColumn || "", context)
        .toUpperCase()
        .trim();
      const filterVal = resolveTemplate(d.readFilterValue || "", context)
        .toLowerCase()
        .trim();
      const rawRowNum = resolveTemplate(d.readRowNumber || "", context).trim();
      const limit =
        d.readLimit === "all" ? Infinity : parseInt(d.readLimit || "1") || 1;
      const headerDefs = (d.readHeaders || "")
        .split(",")
        .map((h) => h.trim())
        .filter(Boolean);

      const rows = await readRows(range);

      let matched;
      // readRowNumber (1-based) overrides filter when set
      if (rawRowNum) {
        const rowIdx = parseInt(rawRowNum, 10) - 1;
        matched =
          !isNaN(rowIdx) && rowIdx >= 0 && rowIdx < rows.length
            ? [rows[rowIdx]]
            : [];
      } else if (filterCol && filterVal !== "") {
        const colIndex = ci(filterCol);
        matched = rows.filter(
          (row) =>
            String(row[colIndex] ?? "")
              .toLowerCase()
              .trim() === filterVal,
        );
      } else {
        matched = rows;
      }

      const limited = limit === Infinity ? matched : matched.slice(0, limit);

      context[`${prefix}.found`] = limited.length > 0;
      context[`${prefix}.count`] = limited.length;
      context[`${prefix}.success`] = true;

      if (limited.length === 0) return;

      // Map first matching row into shorthand context variables ({{prefix.A}} etc.)
      const first = limited[0];
      if (headerDefs.length) {
        headerDefs.forEach((h, i) => {
          context[`${prefix}.${h.replace(/\s+/g, "_").toLowerCase()}`] =
            first[i] ?? "";
        });
      } else {
        first.forEach((val, i) => {
          context[`${prefix}.${String.fromCharCode(65 + i)}`] = val ?? "";
        });
      }
      context[`${prefix}.row`] = first.join(", ");

      // Always store ALL matched rows as 0-based indexed vars:
      // {{prefix.0.A}}, {{prefix.0.row}}, {{prefix.1.A}}, {{prefix.1.row}}, etc.
      limited.forEach((row, ri) => {
        if (headerDefs.length) {
          headerDefs.forEach((h, i) => {
            context[
              `${prefix}.${ri}.${h.replace(/\s+/g, "_").toLowerCase()}`
            ] = row[i] ?? "";
          });
        } else {
          row.forEach((val, i) => {
            context[`${prefix}.${ri}.${String.fromCharCode(65 + i)}`] =
              val ?? "";
          });
        }
        context[`${prefix}.${ri}.row`] = row.join(", ");
      });

      // ── APPEND ────────────────────────────────────────────────────────────────
    } else if (action === "append") {
      const cols = (d.appendColumns || []).filter((c) => c.column);
      if (cols.length === 0) return fail("No columns configured for Append.");

      // Build sparse column map, then fill to an array
      const colMap = {};
      cols.forEach(({ column, value }) => {
        colMap[ci(column)] = resolveTemplate(value ?? "", context);
      });
      const maxIdx = Math.max(...Object.keys(colMap).map(Number));
      const row = Array.from({ length: maxIdx + 1 }, (_, i) => colMap[i] ?? "");

      const lastCol = String.fromCharCode(65 + maxIdx);
      const url =
        `${BASE}/values/${encodeURIComponent(sheetName + "!A:" + lastCol)}` +
        `:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
      const result = await gFetch(url, "POST", { values: [row] });

      context[`${prefix}.success`] = true;
      context[`${prefix}.updatedRange`] = result.updates?.updatedRange ?? "";
      context[`${prefix}.affectedRows`] = result.updates?.updatedRows ?? 1;

      // ── UPDATE ────────────────────────────────────────────────────────────────
    } else if (action === "update") {
      const filterCol = resolveTemplate(d.updateFilterColumn || "A", context)
        .toUpperCase()
        .trim();
      const filterVal = resolveTemplate(d.updateFilterValue || "", context)
        .toLowerCase()
        .trim();
      const updateCols = (d.updateColumns || []).filter((c) => c.column);

      if (!filterVal) return fail("Update filter value is empty.");
      if (updateCols.length === 0)
        return fail("No columns configured for Update.");

      const rows = await readRows("A:Z");
      const colIndex = ci(filterCol);
      const matchedRows = rows
        .map((row, i) =>
          String(row[colIndex] ?? "")
            .toLowerCase()
            .trim() === filterVal
            ? i
            : -1,
        )
        .filter((i) => i >= 0);

      if (matchedRows.length === 0) {
        context[`${prefix}.success`] = true;
        context[`${prefix}.affectedRows`] = 0;
        return;
      }

      // Build batchUpdate data array (one range per cell to update)
      const batchData = [];
      for (const rowIdx of matchedRows) {
        for (const { column, value } of updateCols) {
          if (!column) continue;
          batchData.push({
            range: `${sheetName}!${column.toUpperCase()}${rowIdx + 1}`,
            values: [[resolveTemplate(value ?? "", context)]],
          });
        }
      }

      const result = await gFetch(`${BASE}/values:batchUpdate`, "POST", {
        valueInputOption: "USER_ENTERED",
        data: batchData,
      });

      context[`${prefix}.success`] = true;
      context[`${prefix}.affectedRows`] = matchedRows.length;
      context[`${prefix}.updatedRange`] = (result.responses || [])
        .map((r) => r.updatedRange)
        .join(", ");

      // ── DELETE ────────────────────────────────────────────────────────────────
    } else if (action === "delete") {
      const filterCol = resolveTemplate(d.deleteFilterColumn || "A", context)
        .toUpperCase()
        .trim();
      const filterVal = resolveTemplate(d.deleteFilterValue || "", context)
        .toLowerCase()
        .trim();

      if (!filterVal) return fail("Delete filter value is empty.");

      // Need the numeric sheetId for batchUpdate deleteDimension
      const meta = await gFetch(`${BASE}?fields=sheets.properties`);
      const sheetMeta = (meta.sheets || []).find(
        (s) => s.properties.title === sheetName,
      );
      const sheetId = sheetMeta?.properties?.sheetId ?? 0;

      const rows = await readRows("A:Z");
      const colIndex = ci(filterCol);

      // Collect matching row indices, then reverse so we delete bottom-up
      // (avoids row-index shift after each deletion)
      const toDelete = rows
        .map((row, i) =>
          String(row[colIndex] ?? "")
            .toLowerCase()
            .trim() === filterVal
            ? i
            : -1,
        )
        .filter((i) => i >= 0)
        .reverse();

      if (toDelete.length === 0) {
        context[`${prefix}.success`] = true;
        context[`${prefix}.affectedRows`] = 0;
        return;
      }

      const requests = toDelete.map((rowIdx) => ({
        deleteDimension: {
          range: {
            sheetId,
            dimension: "ROWS",
            startIndex: rowIdx,
            endIndex: rowIdx + 1,
          },
        },
      }));

      await gFetch(`${BASE}:batchUpdate`, "POST", { requests });

      context[`${prefix}.success`] = true;
      context[`${prefix}.affectedRows`] = toDelete.length;
    }
  } catch (err) {
    console.error("[GoogleSheets] Execution error:", err.message);
    context[`${prefix}.success`] = false;
    context[`${prefix}.error`] = err.message;
  }
}

// Execute send message node
async function executeSendMessage(
  messageNode,
  phoneNumber,
  runtimeSessionId,
  context,
) {
  try {
    const { message, delayType, fixedDelay } = messageNode.data || {};

    if (!message) {
      console.warn("No message content in node");
      return;
    }

    const messageToSend = resolveTemplate(message, context);

    // Calculate delay
    let delayMs = 0;
    if (delayType === "random") {
      delayMs = Math.random() * 3000 + 3000; // 3-6 seconds
    } else if (delayType === "fixed") {
      delayMs = (fixedDelay || 5) * 1000;
    }

    // Wait for delay
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    // Send message via WhatsApp service
    try {
      await WhatsAppService.sendMessage(
        runtimeSessionId,
        phoneNumber,
        messageToSend,
      );
      console.log(`📨 Flow message sent to ${phoneNumber}: ${messageToSend}`);
    } catch (error) {
      console.error("Error sending flow message:", error.message);
    }
  } catch (error) {
    console.error("Error in executeSendMessage:", error);
  }
}

// Get flow execution history
export const getFlowExecutionHistory = async (req, res) => {
  try {
    const { flowId } = req.params;
    const { userId } = req.user;

    const flow = await Flow.findOne({ _id: flowId, userId });
    if (!flow) {
      return res.status(404).json({
        success: false,
        message: "Flow not found",
      });
    }

    // TODO: Implement execution history tracking
    res.status(200).json({
      success: true,
      executions: [],
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// Test trigger with sample message
export const testFlowTrigger = async (req, res) => {
  try {
    const { flowId } = req.params;
    const { messageContent, phoneNumber } = req.body;
    const { userId } = req.user;

    const flow = await Flow.findOne({ _id: flowId, userId });
    if (!flow) {
      return res.status(404).json({
        success: false,
        message: "Flow not found",
      });
    }

    // Find trigger node
    const triggerNode = flow.nodes.find((n) => n.type === "trigger");
    if (!triggerNode) {
      return res.status(400).json({
        success: false,
        message: "No trigger node found in flow",
      });
    }

    // Check trigger match
    const isMatch = checkTriggerMatch(triggerNode.data, messageContent);

    res.status(200).json({
      success: true,
      triggerMatches: isMatch,
      message: isMatch
        ? "Trigger would activate"
        : "Trigger would not activate",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// Proxy API request from flow builder to avoid browser CORS restrictions.
export const proxyFlowApiRequest = async (req, res) => {
  try {
    const {
      method = "GET",
      url = "",
      headers = {},
      params = {},
      body = "",
    } = req.body || {};

    if (!url || typeof url !== "string") {
      return res.status(400).json({
        success: false,
        message: "URL is required",
      });
    }

    let urlObject;
    try {
      urlObject = new URL(url);
    } catch {
      return res.status(400).json({
        success: false,
        message: "Invalid URL",
      });
    }

    if (!["http:", "https:"].includes(urlObject.protocol)) {
      return res.status(400).json({
        success: false,
        message: "Only HTTP/HTTPS URLs are allowed",
      });
    }

    Object.entries(params || {}).forEach(([key, value]) => {
      if (!key) return;
      urlObject.searchParams.set(String(key), String(value ?? ""));
    });

    const safeHeaders = {};
    Object.entries(headers || {}).forEach(([key, value]) => {
      if (!key) return;
      const lower = String(key).toLowerCase();
      if (lower === "host" || lower === "content-length") return;
      safeHeaders[key] = String(value ?? "");
    });

    const requestOptions = {
      method: String(method || "GET").toUpperCase(),
      headers: safeHeaders,
    };

    if (
      ["POST", "PUT", "PATCH", "DELETE"].includes(requestOptions.method) &&
      String(body || "").trim()
    ) {
      requestOptions.body = String(body);
    }

    const response = await fetch(urlObject.toString(), requestOptions);
    const contentType = response.headers.get("content-type") || "";

    let data;
    if (contentType.includes("application/json")) {
      data = await response.json();
    } else {
      data = await response.text();
    }

    const responseHeaders = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    res.status(response.ok ? 200 : 400).json({
      success: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      data,
      contentType,
      message: response.ok
        ? "Proxy request successful"
        : "Proxy request failed",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message || "Proxy request failed",
    });
  }
};

// Execute a Google Sheets node in real-time for flow simulation
export const simulateGoogleSheetsNode = async (req, res) => {
  try {
    const { nodeData, inputContext, accessToken: clientToken } = req.body || {};
    const userId = req.user._id;

    if (!nodeData) {
      return res
        .status(400)
        .json({ success: false, message: "nodeData is required" });
    }

    // If the browser sent a fresh token, check if the DB record is missing or
    // expired and upsert it so the execution below always finds a valid token.
    if (clientToken && typeof clientToken === "string" && clientToken.length > 10) {
      const existing = await UserGoogleConnection.findOne({ userId })
        .select("+accessToken")
        .lean();
      const isExpiredOrMissing =
        !existing?.accessToken ||
        (existing.expiresAt && new Date(existing.expiresAt) < new Date());
      if (isExpiredOrMissing) {
        await UserGoogleConnection.findOneAndUpdate(
          { userId },
          { $set: { accessToken: clientToken, expiresAt: new Date(Date.now() + 3595 * 1000) } },
          { upsert: true },
        );
      }
    }

    const prefix = nodeData.outputPrefix || "sheets";
    const context = { ...(inputContext || {}) };
    const mockNode = { data: nodeData };

    await executeGoogleSheetsNode(mockNode, userId, context);

    // Return only the keys that were added/changed by the operation
    const outputContext = {};
    Object.keys(context).forEach((k) => {
      if (k.startsWith(prefix + ".")) {
        outputContext[k] = context[k];
      }
    });

    res.json({ success: true, outputContext });
  } catch (err) {
    res
      .status(500)
      .json({ success: false, message: err.message || "Simulation failed" });
  }
};
