// Served only by the authenticated setup runtime. Drafts stay in this page's memory.
export const SETUP_JAVASCRIPT = `
const byId = id => document.getElementById(id);
const form = byId("connections"), message = byId("setup-message");
const domain = byId("ngrok-domain"), webhook = byId("webhook-url");
const mode = byId("hermes-mode"), localPort = byId("hermes-local-port"), remotePort = byId("hermes-remote-port"), target = byId("hermes-ssh-target"), scope = byId("hermes-endpoint-path"), model = byId("hermes-profile");
const secrets = ["recall-api-key", "recall-webhook-verification-secret", "ngrok-authtoken", "hermes-api-key"].map(byId);
const outcomes = {recall: byId("recall-outcome"), hermes: byId("hermes-outcome"), assistant: byId("assistant-outcome")};
const lists = {recall: byId("component-results"), hermes: byId("hermes-results"), assistant: byId("assistant-results")};
const inputs = [...document.querySelectorAll("input,select")];
const buttons = [...document.querySelectorAll("button")];
const reportGroups = Object.fromEntries(["callback","hermes","assistant","setup"].map(name => [name,{panel:byId(name + "-report-panel"),field:byId(name + "-report"),status:byId("copy-" + name + "-report-status"),button:byId("copy-" + name + "-report"),revision:0}])) , callbackReport = reportGroups.callback.field;
let initial = null, initialDraft = "", mutationLocked = true, active = null, operation = 0;
const revisions = {recall: 0, hermes: 0, assistant: 0};

const setupDiagnosticCodes = new Set(["keychain_access_denied", "keychain_unavailable", "keychain_write_failed", "keychain_missing", "keychain_malformed", "keychain_invalid_request", "keychain_delete_failed", "settings_storage_unavailable", "setup_unknown"]);
async function request(path, options) {
  let response;
  try { response = await fetch(path, {...options, headers: {"Content-Type":"application/json"}}); }
  catch { throw new Error("No response was received. Your unsaved entries are still here."); }
  let body;
  try { body = await response.json(); }
  catch { throw new Error("The setup response could not be read. Your unsaved entries are still here."); }
  if (!response.ok) { const code = setupDiagnosticCodes.has(body.code) ? " [" + body.code + "]" : ""; const error = new Error((body.error || "Setup operation failed. Your unsaved entries are still here.") + code); error.body = body; throw error; }
  return body;
}
function setOutcome(group, kind, text) {
  const node = outcomes[group];
  node.className = "outcome " + kind;
  node.textContent = (kind === "success" ? "✓ " : kind === "warning" ? "⚠ Warning — " : kind === "failure" ? "✕ " : "") + text;
}
function details(group, items) {
  lists[group].replaceChildren();
  for (const text of items) { const item = document.createElement("li"); item.textContent = text; lists[group].append(item); }
}
function clearAgentReport(name) {
  const report = reportGroups[name]; report.revision++; report.panel.hidden = true; report.field.value = ""; report.field.classList.remove("manual-copy"); report.status.textContent = ""; report.button.disabled = true;
}
function setAgentReport(name, lines) {
  const report = reportGroups[name]; report.revision++; report.field.value = lines.join("\\n"); report.field.classList.remove("manual-copy"); report.panel.hidden = false; report.status.textContent = ""; report.button.disabled = false;
}
function clearCallbackReport() {
  clearAgentReport("callback"); byId("recall-details").open = false;
}
function syncControls() {
  for (const input of inputs) input.disabled = mutationLocked;
  for (const button of buttons) button.disabled = mutationLocked || active !== null;
  for (const report of Object.values(reportGroups)) report.button.disabled = report.panel.hidden || !report.field.value;
  byId("reload").hidden = initial?.mode !== "ready";
  byId("reload").disabled ||= initial?.mode !== "ready";
  byId("return-guidance").hidden = initial?.mode === "ready";
  target.disabled = mutationLocked || mode.value !== "ssh";
  remotePort.disabled = mutationLocked || mode.value !== "ssh";
  byId("remote-fields").hidden = mode.value !== "ssh";
  const host = target.value.trim().split("@").pop() || "";
  byId("remote-network-note").textContent = /(?:\\.local$|^10\\.|^192\\.168\\.|^172\\.(?:1[6-9]|2[0-9]|3[01])\\.)/i.test(host) ? "This address usually works only on that network. Use the Hermes Mac’s Tailscale IP when away." : "";
  const validPort = input => Number.isInteger(Number(input.value)) && Number(input.value) > 0 && Number(input.value) <= 65535;
  const prerequisites = mode.value && validPort(localPort) && scope.value.trim() && (secrets[3].value || initial?.configured.hermesApiKey) && (mode.value !== "ssh" || (target.value.trim() && validPort(remotePort)));
  byId("discover-hermes-profiles").disabled ||= !prerequisites;
  byId("model-prerequisite").textContent = prerequisites ? "Load models, then choose one yourself. Loading does not test assistant inference." : "Choose a mode and enter its address, API key, scope and ports before loading models.";
  model.disabled = mutationLocked || model.options.length < 2;
  byId("test-hermes-assistant").disabled ||= !model.value;
}
function setModels(values, selected = "") {
  model.replaceChildren();
  const empty = document.createElement("option"); empty.value = "";
  empty.textContent = values.length ? "Choose a model" : "Load models first"; model.append(empty);
  for (const value of values) { const item = document.createElement("option"); item.value = value; item.textContent = value; model.append(item); }
  model.value = values.includes(selected) ? selected : "";
  syncControls();
}
function resetEvidence() {
  clearCallbackReport();
  clearAgentReport("hermes"); clearAgentReport("assistant"); clearAgentReport("setup");
  for (const group of Object.keys(outcomes)) { revisions[group]++; setOutcome(group, "", ""); details(group, []); }
}
function invalidate(group) {
  clearAgentReport("setup");
  if (group === "recall") clearCallbackReport();
  if (group === "hermes") { clearAgentReport("hermes"); clearAgentReport("assistant"); }
  if (group === "assistant") clearAgentReport("assistant");
  revisions[group]++;  details(group, []);
  setOutcome(group, "stale", group === "recall" ? "Changed — test again" : group === "assistant" ? "Model changed — test assistant again" : "Changed — load models again");
  if (group === "hermes") { setModels([]); revisions.assistant++; details("assistant", []); setOutcome("assistant", "", ""); }
}
function updateWebhook() { webhook.textContent = domain.value.trim() ? "https://" + domain.value.trim() + "/api/capture/recall/webhook" : "Enter a stable domain."; }
function renderOverview(value) {
  byId("setup-status").textContent = ({ready:"Saved connections ready",setup_required:"Setup needed",needs_attention:"Settings need attention"})[value.mode] || "Setup needed";
  byId("credential-status").textContent = Object.values(value.configured).filter(Boolean).length + " of 4 saved";
  domain.value = value.ngrokDomain || ""; mode.value = value.hermesMode || "";
  localPort.value = String(value.hermesLocalPort); remotePort.value = String(value.hermesRemotePort);
  target.value = value.hermesSshTarget || ""; scope.value = value.hermesEndpointPath || "/";
  setModels(value.hermesProfile ? [value.hermesProfile] : [], value.hermesProfile || "");
  initial = value; initialDraft = JSON.stringify(inputs.map(input => input.value)); updateWebhook(); syncControls();
}
function eraseDraft() { for (const input of secrets) input.value = ""; initialDraft = JSON.stringify(inputs.map(input => input.value)); }
function recallPayload() { return {ngrokDomain:domain.value.trim(), recallApiKey:secrets[0].value, recallWebhookVerificationSecret:secrets[1].value, ngrokAuthtoken:secrets[2].value}; }
function effectiveRemotePort() {
  const draft = Number(remotePort.value);
  return mode.value === "ssh" || (Number.isInteger(draft) && draft > 0 && draft <= 65535) ? draft : initial.hermesRemotePort;
}
function hermesPayload() {
  if (!mode.value) throw new Error("Choose where Hermes runs first.");
  return {hermesMode:mode.value, hermesLocalPort:Number(localPort.value), hermesRemotePort:effectiveRemotePort(), hermesSshTarget:mode.value === "ssh" ? target.value.trim() : null, hermesEndpointPath:scope.value.trim(), hermesApiKey:secrets[3].value};
}
function savePayload() { return {...recallPayload(), hermesMode:mode.value || null, hermesLocalPort:Number(localPort.value), hermesRemotePort:effectiveRemotePort(), hermesSshTarget:mode.value === "ssh" ? target.value.trim() : null, hermesEndpointPath:scope.value.trim(), hermesProfile:mode.value ? model.value || null : null, hermesApiKey:secrets[3].value}; }
for (const input of [domain,...secrets.slice(0,3)]) input.addEventListener("input", () => { invalidate("recall"); updateWebhook(); });
for (const input of [localPort, remotePort, target, scope, secrets[3]]) input.addEventListener("input", () => { invalidate("hermes"); syncControls(); });
mode.addEventListener("change", () => { invalidate("hermes"); syncControls(); });
model.addEventListener("change", () => { invalidate("assistant"); syncControls(); });

async function run(group, progress, action, render) {
  if (mutationLocked || active !== null) return;
  const id = ++operation, revision = revisions[group]; active = id; syncControls();
  setOutcome(group, "progress", progress); details(group, []); if (group === "recall") clearCallbackReport(); else clearAgentReport(group);
  try {
    const value = await action();
    if (active !== id || revision !== revisions[group]) return;
    if (value.state === "stale") { setOutcome(group, "stale", "Settings changed — run again"); return; }
    render(value);
  } catch (error) {
    if (active === id && revision === revisions[group]) {
      const stale = error.body?.state === "stale";
      setOutcome(group, stale ? "stale" : "failure", stale ? "Settings changed — run again" : error.message);
      if (!stale) showRequestFailureReport(group,error);
      if (group === "recall" && !stale) {
        details("recall", ["The connection test could not complete. Your entries remain unchanged. Retry once; if it repeats, share only this message and any allowlisted setup code."]);
        byId("recall-details").open = true;
      }
    }
  } finally { if (active === id) { active = null; syncControls(); } }
}
function callbackDetail(check) {
  const diagnostic = check.diagnostic;
  if (!diagnostic) return check.state.replaceAll("_", " ");
  const advice = {
    http_status: "HTTP " + diagnostic.httpStatus + "; expected 204.",
    timeout: "Callback timed out.",
    dns_failed: "DNS lookup failed.",
    tls_certificate_failed: "TLS certificate verification failed.",
    tls_protocol_failed: "Invalid HTTPS response.",
    connection_refused: "Connection refused.",
    connection_reset: "Connection reset.",
    network_unreachable: "Network unreachable.",
    connect_failed: "Connection failed.",
    not_attempted: "Not attempted; an earlier step failed.",
    ngrok_start_failed: "ngrok did not start.",
    ngrok_domain_mismatch: "ngrok returned a different domain.",
    local_listener_failed: "Local callback listener failed.",
  };
  return Object.hasOwn(advice, diagnostic.code) ? advice[diagnostic.code] + " [" + diagnostic.code + "]" : "Failed. Review this step’s prerequisites. If seeking help, share only the step name, never credentials.";
}
function diagnosticToken(check) {
  if (check.state === "unverified") return "unverified";
  if (!check.diagnostic) {
    const allowedStates = new Set(["verified_synthetic","verified_exact_domain","failed"]);
    return allowedStates.has(check.state) ? check.state : "failed [connect_failed]";
  }
  const code = safeDiagnosticCode(check.diagnostic);
  if (code === "http_status") return "failed [http_status; HTTP " + check.diagnostic.httpStatus + "]";
  return "failed [" + code + "]";
}
function safeDiagnosticCode(diagnostic) {
  const allowed = new Set(["timeout","dns_failed","tls_certificate_failed","tls_protocol_failed","connection_refused","connection_reset","network_unreachable","connect_failed","not_attempted","ngrok_start_failed","ngrok_domain_mismatch","local_listener_failed"]);
  if (diagnostic?.code === "http_status" && Number.isInteger(diagnostic.httpStatus) && diagnostic.httpStatus >= 100 && diagnostic.httpStatus <= 599) return "http_status";
  return allowed.has(diagnostic?.code) ? diagnostic.code : "connect_failed";
}
function callbackReportResult(classified) {
  const value = classified.value;
  if (!classified.consistent) return "Result: component evidence was missing or inconsistent; whether a public callback was attempted is unknown.";
  if (value.publicWebhook.state === "verified_synthetic") return "Result: the signed synthetic public callback reached Caddy through the temporary public tunnel.";
  const publicCode = safeDiagnosticCode(value.publicWebhook.diagnostic);
  if (publicCode === "not_attempted") return "Result: the public callback was not attempted because an earlier prerequisite failed.";
  return "Result: Caddy attempted the signed synthetic public callback through the temporary public tunnel, but the route was not verified.";
}
function callbackReportNextAction(classified) {
  const value = classified.value;
  if (!classified.consistent) return "Next action: retry once. If the result repeats, share this secret-free report for setup-result troubleshooting.";
  if (value.recallCredentials.state === "authentication_rejected") return "Next action: check that the Recall API key belongs to the US West workspace, then retry. Do not share or dump credentials.";
  if (value.recallCredentials.state !== "authenticated_read_only") return "Next action: retry when this Mac can reach the Recall API. If it repeats, check network access and Recall service availability; this result does not prove the key is wrong.";
  if (value.localWebhook.state !== "verified_synthetic") return "Next action: retry the local callback listener once. If it repeats, share this secret-free report for local listener troubleshooting.";
  if (value.ngrokEndpoint.state !== "verified_exact_domain") return "Next action: check the ngrok authtoken, stable domain and domain ownership. Do not stop an unfamiliar process or reset unrelated credentials.";
  if (value.publicWebhook.state === "verified_synthetic") return "Next action: no callback recovery is needed for these synthetic checks. Confirm Recall dashboard event selections and the workspace signing secret separately.";
  const code = safeDiagnosticCode(value.publicWebhook.diagnostic);
  const actions = {
    http_status: "Next action: check that the actual running Caddy copy owns the ngrok domain and that no redirect or access-policy page intercepts it.",
    timeout: "Next action: check this Mac’s connectivity and ngrok availability, then compare once on another trusted network.",
    dns_failed: "Next action: check this Mac’s DNS connectivity, then compare once on another trusted network.",
    tls_certificate_failed: "Next action: check this Mac’s clock and the trusted or managed-network certificate policy. Do not bypass certificate verification.",
    tls_protocol_failed: "Next action: check network-security history or ask the managed-network administrator, then compare once on another trusted network. Filtering is possible, not proven.",
    connection_refused: "Next action: check ngrok status and domain ownership for the actual running Caddy copy.",
    connection_reset: "Next action: check network-security history or ask the managed-network administrator, then compare once on another trusted network. Filtering is possible, not proven.",
    network_unreachable: "Next action: check this Mac’s network route, then compare once on another trusted network.",
    connect_failed: "Next action: check DNS, network and ngrok availability, then compare once on another trusted network if the cause remains unclear.",
    not_attempted: "Next action: resolve the earlier endpoint failure before testing the public callback.",
    ngrok_start_failed: "Next action: check the ngrok authtoken, stable domain and domain ownership.",
    ngrok_domain_mismatch: "Next action: check the assigned stable domain before retrying.",
    local_listener_failed: "Next action: retry the local listener once, then share this secret-free report if it repeats."
  };
  return actions[code] || actions.connect_failed;
}
const warningPublicCodes = new Set(["http_status","timeout","dns_failed","tls_certificate_failed","tls_protocol_failed","connection_refused","connection_reset","network_unreachable","connect_failed"]);
const knownDiagnosticCodes = new Set([...warningPublicCodes,"not_attempted","ngrok_start_failed","ngrok_domain_mismatch","local_listener_failed"]);
function isConsistentDiagnostic(diagnostic) {
  if (!diagnostic || typeof diagnostic !== "object" || !knownDiagnosticCodes.has(diagnostic.code)) return false;
  if (diagnostic.code === "http_status") return Number.isInteger(diagnostic.httpStatus) && diagnostic.httpStatus >= 100 && diagnostic.httpStatus <= 599 && diagnostic.httpStatus !== 204;
  return !Object.hasOwn(diagnostic,"httpStatus");
}
function isConsistentCheck(check, successState, allowedFailureCodes) {
  if (!check || typeof check !== "object") return false;
  if (check.state === successState) return !Object.hasOwn(check,"diagnostic");
  return check.state === "failed" && isConsistentDiagnostic(check.diagnostic) && allowedFailureCodes.has(check.diagnostic.code);
}
function normalizeConnectionResult(value) {
  const safe = value && typeof value === "object" ? value : {};
  const unavailable = () => ({state:"unverified"});
  const recall = safe.recallCredentials && typeof safe.recallCredentials === "object" && ["authenticated_read_only","authentication_rejected","unavailable"].includes(safe.recallCredentials.state) && !Object.hasOwn(safe.recallCredentials,"diagnostic") ? safe.recallCredentials : unavailable();
  const check = (candidate, successState, allowedFailureCodes) => isConsistentCheck(candidate,successState,allowedFailureCodes) ? candidate : unavailable();
  return {
    recallCredentials:recall,
    localWebhook:check(safe.localWebhook,"verified_synthetic",new Set([...warningPublicCodes,"local_listener_failed"])),
    ngrokEndpoint:check(safe.ngrokEndpoint,"verified_exact_domain",new Set(["ngrok_start_failed","ngrok_domain_mismatch","not_attempted"])),
    publicWebhook:check(safe.publicWebhook,"verified_synthetic",new Set([...warningPublicCodes,"not_attempted","ngrok_start_failed","ngrok_domain_mismatch","local_listener_failed"]))
  };
}
function classifyConnectionResult(raw) {
  const value = normalizeConnectionResult(raw);
  const recallConsistent = value.recallCredentials.state !== "unverified";
  const localConsistent = isConsistentCheck(value.localWebhook,"verified_synthetic",new Set([...warningPublicCodes,"local_listener_failed"]));
  const ngrokConsistent = isConsistentCheck(value.ngrokEndpoint,"verified_exact_domain",new Set(["ngrok_start_failed","ngrok_domain_mismatch","not_attempted"]));
  const publicConsistent = isConsistentCheck(value.publicWebhook,"verified_synthetic",new Set([...warningPublicCodes,"not_attempted","ngrok_start_failed","ngrok_domain_mismatch","local_listener_failed"]));
  const consistent = recallConsistent && localConsistent && ngrokConsistent && publicConsistent;
  const prerequisitesPass = value.recallCredentials.state === "authenticated_read_only" && value.localWebhook.state === "verified_synthetic" && value.ngrokEndpoint.state === "verified_exact_domain";
  if (consistent && prerequisitesPass && value.publicWebhook.state === "verified_synthetic") return {severity:"success",consistent,value};
  const warning = consistent && prerequisitesPass && value.publicWebhook.state === "failed" && warningPublicCodes.has(value.publicWebhook.diagnostic.code);
  return {severity:warning ? "warning" : "failure",consistent,value};
}
function callbackReportLimits(classified) {
  const value = classified.value;
  const base = "Limits: no bot was created; this does not prove Recall delivery, dashboard event selections, that the entered signing secret matches the Recall workspace, or provider retention.";
  return classified.consistent && value.ngrokEndpoint.state === "verified_exact_domain" ? base + " The temporary tunnel closes after the test, so a later offline HTTP result is not this test failing." : base;
}
function showCallbackReport(classified) {
  const {severity,value} = classified;
  setAgentReport("callback",[
    "Convo Caddy callback diagnostic",
    "Overall severity: " + severity,
    "Recall credentials: " + value.recallCredentials.state,
    "Local callback: " + diagnosticToken(value.localWebhook),
    "ngrok endpoint: " + diagnosticToken(value.ngrokEndpoint),
    "Public callback: " + diagnosticToken(value.publicWebhook),
    callbackReportResult(classified),
    callbackReportLimits(classified),
    callbackReportNextAction(classified),
    ...(severity === "warning" ? ["Recommended next action: make one real private Teams test call—alone is fine—before relying on this setup; admit the visible bot deliberately and confirm live transcript text appears in Caddy."] : []),
    "Safety: do not disable protection globally, dump credentials, or retry until green."
  ]);
}
byId("test-connections").addEventListener("click", () => run("recall", "Checking…", () => request("/api/setup/connections/test", {method:"POST", body:JSON.stringify(recallPayload())}), value => {
  const classified = classifyConnectionResult(value), result = classified.value;
  const failureTitle = result.recallCredentials.state === "authentication_rejected" ? "Recall authentication was rejected — check the API key and US West workspace." : result.recallCredentials.state === "unavailable" ? "Recall authentication could not be verified — retry, then check network or Recall service availability." : "Connection checks failed — review the expanded diagnostics for the first blocking step.";
  const text = classified.severity === "success" ? "Synthetic checks passed" : classified.severity === "warning" ? "Setup not fully verified. Make a solo Teams call and check that transcript text appears." : failureTitle;
  setOutcome("recall", classified.severity, text);
  byId("recall-details").open = classified.severity === "failure";
  details("recall", ["Recall credentials: " + String(result.recallCredentials.state).replaceAll("_"," "), "Local callback: " + callbackDetail(result.localWebhook), "ngrok endpoint: " + callbackDetail(result.ngrokEndpoint), "Public callback: " + callbackDetail(result.publicWebhook), "Synthetic only: no bot or live delivery was verified."]);
  showCallbackReport(classified);
}));
async function copyAgentReport(name) {
  const report = reportGroups[name]; if (report.panel.hidden || !report.field.value) return;
  const revision = report.revision, value = report.field.value;
  let copied = false;
  try { await navigator.clipboard.writeText(value); copied = true; }
  catch { if (report.revision !== revision || report.field.value !== value || report.panel.hidden) return; report.field.classList.add("manual-copy"); report.field.focus(); report.field.select(); try { copied = document.execCommand("copy"); } catch {} if (copied) report.field.classList.remove("manual-copy"); }
  if (report.revision !== revision || report.field.value !== value || report.panel.hidden) return;
  report.status.textContent = copied ? "Copied" : "Press Command-C to copy the selected summary.";
}
for (const name of Object.keys(reportGroups)) reportGroups[name].button.addEventListener("click", () => copyAgentReport(name));
function safeSetupCode(error) { return setupDiagnosticCodes.has(error?.body?.code) ? error.body.code : "setup_unknown"; }
function showRequestFailureReport(group,error) {
  const definitions = {recall:["callback","Recall and ngrok test"],hermes:["hermes","Hermes model discovery"],assistant:["assistant","Hermes assistant test"]};
  const [name,operationName] = definitions[group];
  setAgentReport(name,["Convo Caddy setup diagnostic","Operation: " + operationName,"Result: request_failed [" + safeSetupCode(error) + "]","Entries were retained. No raw error, credential, address, URL, transcript, or filesystem value is included.","Next action: retry once, then give this summary to your agent."]);
}
function safeHermesState(state, allowed) { return allowed.includes(state) ? state : "unknown_failure"; }
function showHermesResultReport(name,operationName,state) {
  setAgentReport(name,["Convo Caddy setup diagnostic","Operation: " + operationName,"Result: failed [" + state + "]","No raw response, credential, model content, address, host, SSH identity, or filesystem value is included.","Next action: give this summary to your agent and use the setup guide."]);
}
byId("discover-hermes-profiles").addEventListener("click", () => {
  if (mutationLocked || active !== null) return;
  clearAgentReport("assistant"); setModels([]); revisions.assistant++; setOutcome("assistant", "", ""); details("assistant", []);
  return run("hermes", "Checking connection…", () => request("/api/setup/connections/hermes/discover", {method:"POST",body:JSON.stringify(hermesPayload())}), value => {
    if (value.state === "profiles_advertised" && value.profiles.length) {
      setModels(value.profiles); setOutcome("hermes", "success", "Connected — models loaded");
      details("hermes", ["Authenticated Hermes metadata loaded. Assistant inference is a separate test."]);
    } else { const state = safeHermesState(value.state,["authentication_rejected","identity_rejected","models_rejected","profiles_advertised","forwarding_unavailable","ssh_failed","transport_unknown","unavailable"]); setModels([]); setOutcome("hermes", "failure", hermesFailure(state)); details("hermes", ["Result: " + state.replaceAll("_"," ")]); showHermesResultReport("hermes","Hermes model discovery",state); }
  });
});
byId("test-hermes-assistant").addEventListener("click", () => run("assistant", "Testing assistant…", () => {
  if (!model.value) throw new Error("Choose a loaded model first.");
  return request("/api/setup/connections/hermes/test", {method:"POST",body:JSON.stringify({...hermesPayload(),hermesProfile:model.value})});
}, value => {
  const passed = value.state === "assistant_verified_synthetic";
  setOutcome("assistant", passed ? "success" : "failure", passed ? "Assistant test passed" : "Assistant test failed — check the selected model and Hermes provider configuration before retrying.");
  const state = passed ? "assistant_verified_synthetic" : safeHermesState(value.state,["response_rejected","profile_not_advertised","authentication_rejected","identity_rejected","models_rejected","unavailable","ssh_failed","forwarding_unavailable","transport_unknown"]);
  details("assistant", ["Result: " + state.replaceAll("_"," ")]);
  if (!passed) showHermesResultReport("assistant","Hermes assistant test",state);
}));

function hermesFailure(state) {
  return ({
    authentication_rejected: "Incorrect API key — verify the listener owner’s API_SERVER_KEY, then load models again.",
    identity_rejected: "Invalid scope or incompatible Hermes response — verify the profile scope and supported version.",
    models_rejected: "Hermes returned an incompatible model list — verify the scope and supported version.",
    profiles_advertised: "No models advertised — ask the Hermes owner to verify its model routes.",
    forwarding_unavailable: "Forwarding unavailable — choose a free local port. The existing listener was preserved.",
    ssh_failed: "SSH could not connect — check the private network, key unlock and trusted host using the guide’s strict SSH command.",
    transport_unknown: "Unknown transport failure — verify the profile scope, address and listener configuration. No cause has been confirmed; load models again after checking.",
    unavailable: "Hermes unreachable or timed out — verify both Macs are online and awake, the private network, and the host’s loopback API port. Then load models again."
  })[state] || "Unknown connection failure — verify the address and host configuration, then load models again.";
}
function showSetupFailureReport(operationName,error,uncertain = false,disposition = "The unsaved draft was retained.") {
  setAgentReport("setup",["Convo Caddy setup diagnostic","Operation: " + operationName,"Result: " + (uncertain ? "response_unconfirmed" : "failed") + " [" + safeSetupCode(error) + "]",disposition + " No raw error, credential, address, URL, transcript, filesystem, user, host, or SSH value is included.","Next action: give this summary to your agent before resetting credentials."]);
}
function showSetupStatusReport(operationName,result,disposition,nextAction) {
  setAgentReport("setup",["Convo Caddy setup diagnostic","Operation: " + operationName,"Result: " + result,disposition + " No raw error, credential, address, URL, transcript, filesystem, user, host, or SSH value is included.","Next action: " + nextAction]);
}

function beginMutation() {
  if (mutationLocked || active !== null) return false;
  mutationLocked = true; syncControls(); return true;
}
async function acknowledgeSaved() {
  try {
    await request("/api/setup/save-acknowledgement", {method:"POST",body:"{}"});
    message.textContent = "Settings saved. Reloading Convo Caddy… If this page remains, quit and reopen Convo Caddy.";
  } catch (error) {
    // Delivery may have succeeded. Never unlock a document whose teardown may be queued.
    message.textContent = "Settings saved. Reload confirmation was not received. Quit and reopen Convo Caddy; editing stays locked to protect your saved settings.";
    showSetupFailureReport("Confirm saved settings reload",error,true,"Settings were saved and secret drafts were erased; editing remains locked because reload delivery is uncertain.");
  }
}
let closeApproved = false, closePreviousLock = false;
// Document-local Back authority exists only after confirmed discard. Keep it
// through a lost reply: runtime navigation may already be queued. A known
// refusal revokes it and restores the untouched draft; a new document resets it.
let backApproved = false;
function refuseBack(text,error) {
  if (closeApproved) return;
  backApproved = false; message.textContent = text;
  showSetupFailureReport("Return to app",error,false,"The unsaved draft was retained and navigation was refused.");
  mutationLocked = false; syncControls();
}
const hasCloseDraft = () => initial !== null && JSON.stringify(inputs.map(input => input.value)) !== initialDraft;
window.caddyPrepareClose = async action => {
  if (action === "cancel") { if (closeApproved) {closeApproved = false; mutationLocked = closePreviousLock; syncControls();} return "clean"; }
  if (action === "status") return hasCloseDraft() ? "dirty" : "clean";
  if (!["clean", "save", "discard"].includes(action)) return "blocked";
  // Back may already have queued replacement. Do not repeat uncertain writes,
  // but explicit Discard can close this draft without undoing durable settings.
  if (active !== null) return "blocked";
  if (mutationLocked && hasCloseDraft() && !(action === "discard" && backApproved)) {
    if (backApproved) message.textContent = "Return is unconfirmed. Choose Discard to quit without saving these entries. Already saved settings stay saved.";
    return "blocked";
  }
  if (action === "clean" && hasCloseDraft()) return "dirty";
  const previousLock = mutationLocked;
  if (action === "save") {
    if (!beginMutation()) return "blocked";
    try {
      const value = await request("/api/setup/connections", {method:"PUT",body:JSON.stringify(savePayload())});
      renderOverview(value); eraseDraft(); resetEvidence();
      message.textContent = "Settings saved.";
    } catch (error) { message.textContent = error.message; showSetupFailureReport("Save settings",error); mutationLocked = false; syncControls(); return "blocked"; }
  }
  closePreviousLock = previousLock; closeApproved = true; mutationLocked = true; syncControls(); return "ready";
};
window.addEventListener("beforeunload", event => {if (!closeApproved && !backApproved && hasCloseDraft()) event.preventDefault();});
form.addEventListener("submit", async event => {
  event.preventDefault(); if (!beginMutation()) return;
  clearAgentReport("setup");
  message.textContent = "Saving securely…";
  let value;
  try { value = await request("/api/setup/connections", {method:"PUT",body:JSON.stringify(savePayload())}); }
  catch (error) {
    message.textContent = error.message + (error.message.startsWith("No response") || error.message.startsWith("The setup response") ? " The save may have completed; retrying is safe." : "");
    showSetupFailureReport("Save settings",error,error.message.startsWith("No response") || error.message.startsWith("The setup response"));
    mutationLocked = false; syncControls(); return;
  }
  renderOverview(value); eraseDraft(); resetEvidence();
  message.textContent = "Settings saved. Finishing reload…";
  await acknowledgeSaved();
});
byId("reset").addEventListener("click", async () => {
  if (mutationLocked || active !== null || !confirm("Remove saved Convo Caddy credentials? Unsaved entries remain if reset fails.") || !beginMutation()) return;
  clearAgentReport("setup");
  try { const value = await request("/api/setup/credentials", {method:"DELETE",body:JSON.stringify({confirm:true})}); resetEvidence(); eraseDraft(); renderOverview(value); message.textContent = "Saved credentials removed."; }
  catch (error) { message.textContent = error.message; showSetupFailureReport("Reset credentials",error); }
  finally { mutationLocked = false; syncControls(); }
});
byId("reload").addEventListener("click", async () => {
  if (mutationLocked || active !== null || initial?.mode !== "ready") return;
  const hasChanges = JSON.stringify(inputs.map(input => input.value)) !== initialDraft;
  if ((hasChanges && !confirm("Leave settings and discard unsaved changes?")) || !beginMutation()) return;
  backApproved = true;
  try { await request("/api/setup/reload", {method:"POST",body:"{}"}); }
  catch (error) {
    if (error.body) { refuseBack(error.message,error); return; }
    // A lost POST reply is not a refusal. Reconcile read-only without issuing
    // another mutation or revoking an already approved navigation.
  }
  if (closeApproved) return;
  message.textContent = "Returning to Convo Caddy…";
  const deadline = Date.now() + 10000;
  while (!closeApproved && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 250));
    try {
      const result = await request("/api/setup/reload", {signal: AbortSignal.timeout(Math.max(1, Math.min(1000, deadline - Date.now())))});
      if (closeApproved) return;
      if (result.state === "blocked") {refuseBack("Could not return to the app. Your entries are still here; try again when the current operation finishes.",{body:{code:"setup_unknown"}});return;}
      if (result.state === "reloaded") return;
    } catch { /* Read-only reconciliation can retry after a lost or unreadable status. */ }
  }
  if (closeApproved) return;
  message.textContent = "Return could not be confirmed. Your entries are still here; editing stays locked while return is uncertain. Quit and reopen when ready to leave settings.";
  showSetupStatusReport("Confirm return to app","response_unconfirmed [setup_unknown]","The unsaved draft remains in this locked page while navigation is uncertain.","give this summary to your agent, then quit and reopen Convo Caddy when ready.");
});
// Quit and Back grant only document-local, explicitly approved unload authority.
syncControls();
request("/api/setup").then(value => { renderOverview(value); mutationLocked = false; syncControls(); }).catch(error => { message.textContent = "Saved setup could not be loaded. Quit and reopen Convo Caddy; no draft has been changed."; showSetupFailureReport("Load saved setup",error,false,"No setup values were loaded and editing remains locked."); syncControls(); });
`;
