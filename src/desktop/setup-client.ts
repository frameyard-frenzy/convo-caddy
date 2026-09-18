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
  node.textContent = (kind === "success" ? "✓ " : kind === "failure" ? "✕ " : "") + text;
}
function details(group, items) {
  lists[group].replaceChildren();
  for (const text of items) { const item = document.createElement("li"); item.textContent = text; lists[group].append(item); }
}
function syncControls() {
  for (const input of inputs) input.disabled = mutationLocked;
  for (const button of buttons) button.disabled = mutationLocked || active !== null;
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
  for (const group of Object.keys(outcomes)) { revisions[group]++; setOutcome(group, "", "Not tested"); details(group, []); }
}
function invalidate(group) {
  revisions[group]++;  details(group, []);
  setOutcome(group, "stale", group === "recall" ? "Changed — test again" : group === "assistant" ? "Model changed — test assistant again" : "Changed — load models again");
  if (group === "hermes") { setModels([]); revisions.assistant++; details("assistant", []); setOutcome("assistant", "", "Not tested"); }
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
  setOutcome(group, "progress", progress); details(group, []);
  try {
    const value = await action();
    if (active !== id || revision !== revisions[group]) return;
    if (value.state === "stale") { setOutcome(group, "stale", "Settings changed — run again"); return; }
    render(value);
  } catch (error) {
    if (active === id && revision === revisions[group]) {
      setOutcome(group, error.body?.state === "stale" ? "stale" : "failure", error.body?.state === "stale" ? "Settings changed — run again" : error.message);
    }
  } finally { if (active === id) { active = null; syncControls(); } }
}
function callbackDetail(check) {
  const diagnostic = check.diagnostic;
  if (!diagnostic) return check.state.replaceAll("_", " ");
  const advice = {
    http_status: "HTTP " + diagnostic.httpStatus + " (expected 204). Check the ngrok domain routes to Caddy and has no redirect or access-policy page, then retry.",
    timeout: "Timed out waiting for the callback. Check this Mac’s network and ngrok availability, then retry.",
    connect_failed: "Could not connect. Check DNS, network and ngrok availability, then retry.",
    not_attempted: "Not attempted because an earlier endpoint step failed. Resolve that step first.",
    ngrok_start_failed: "ngrok could not start. Check its authtoken, stable domain and whether another tunnel owns that domain, then retry.",
    ngrok_domain_mismatch: "ngrok returned a different endpoint. Check the assigned stable domain before retrying.",
    local_listener_failed: "Caddy could not open its temporary local callback listener. Retry; if it repeats, use this code to troubleshoot local listener access.",
  };
  return Object.hasOwn(advice, diagnostic.code) ? advice[diagnostic.code] + " [" + diagnostic.code + "]" : "Failed. Review this step’s prerequisites. If seeking help, share only the step name, never credentials.";
}
byId("test-connections").addEventListener("click", () => run("recall", "Checking…", () => request("/api/setup/connections/test", {method:"POST", body:JSON.stringify(recallPayload())}), value => {
  const states = [value.recallCredentials.state,value.localWebhook.state,value.ngrokEndpoint.state,value.publicWebhook.state];
  const passed = states.every(state => ["authenticated_read_only","verified_synthetic","verified_exact_domain"].includes(state));
  setOutcome("recall", passed ? "success" : "failure", passed ? "Connection checks passed" : "Connection checks failed — open Diagnostic details below for the failed step and next action.");
  details("recall", ["Recall credentials: " + value.recallCredentials.state.replaceAll("_"," "), "Local callback: " + callbackDetail(value.localWebhook), "ngrok endpoint: " + callbackDetail(value.ngrokEndpoint), "Public callback: " + callbackDetail(value.publicWebhook), "No bot was created; dashboard subscriptions and provider retention were not verified."]);
}));
byId("discover-hermes-profiles").addEventListener("click", () => {
  if (mutationLocked || active !== null) return;
  setModels([]); revisions.assistant++; setOutcome("assistant", "", "Not tested"); details("assistant", []);
  return run("hermes", "Checking connection…", () => request("/api/setup/connections/hermes/discover", {method:"POST",body:JSON.stringify(hermesPayload())}), value => {
    if (value.state === "profiles_advertised" && value.profiles.length) {
      setModels(value.profiles); setOutcome("hermes", "success", "Connected — models loaded");
      details("hermes", ["Authenticated Hermes metadata loaded. Assistant inference is a separate test."]);
    } else { setModels([]); setOutcome("hermes", "failure", hermesFailure(value.state)); details("hermes", ["Result: " + value.state.replaceAll("_"," ")]); }
  });
});
byId("test-hermes-assistant").addEventListener("click", () => run("assistant", "Testing assistant…", () => {
  if (!model.value) throw new Error("Choose a loaded model first.");
  return request("/api/setup/connections/hermes/test", {method:"POST",body:JSON.stringify({...hermesPayload(),hermesProfile:model.value})});
}, value => {
  const passed = value.state === "assistant_verified_synthetic";
  setOutcome("assistant", passed ? "success" : "failure", passed ? "Assistant test passed" : "Assistant test failed — check the selected model and Hermes provider configuration before retrying.");
  details("assistant", ["Result: " + value.state.replaceAll("_"," ")]);
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

function beginMutation() {
  if (mutationLocked || active !== null) return false;
  mutationLocked = true; syncControls(); return true;
}
async function acknowledgeSaved() {
  try {
    await request("/api/setup/save-acknowledgement", {method:"POST",body:"{}"});
    message.textContent = "Settings saved. Reloading Convo Caddy… If this page remains, quit and reopen Convo Caddy.";
  } catch {
    // Delivery may have succeeded. Never unlock a document whose teardown may be queued.
    message.textContent = "Settings saved. Reload confirmation was not received. Quit and reopen Convo Caddy; editing stays locked to protect your saved settings.";
  }
}
let closeApproved = false, closePreviousLock = false;
// Document-local Back authority exists only after confirmed discard. Keep it
// through a lost reply: runtime navigation may already be queued. A known
// refusal revokes it and restores the untouched draft; a new document resets it.
let backApproved = false;
function refuseBack(text) {
  if (closeApproved) return;
  backApproved = false; message.textContent = text;
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
    } catch (error) { message.textContent = error.message; mutationLocked = false; syncControls(); return "blocked"; }
  }
  closePreviousLock = previousLock; closeApproved = true; mutationLocked = true; syncControls(); return "ready";
};
window.addEventListener("beforeunload", event => {if (!closeApproved && !backApproved && hasCloseDraft()) event.preventDefault();});
form.addEventListener("submit", async event => {
  event.preventDefault(); if (!beginMutation()) return;
  message.textContent = "Saving securely…";
  let value;
  try { value = await request("/api/setup/connections", {method:"PUT",body:JSON.stringify(savePayload())}); }
  catch (error) {
    message.textContent = error.message + (error.message.startsWith("No response") || error.message.startsWith("The setup response") ? " The save may have completed; retrying is safe." : "");
    mutationLocked = false; syncControls(); return;
  }
  renderOverview(value); eraseDraft(); resetEvidence();
  message.textContent = "Settings saved. Finishing reload…";
  await acknowledgeSaved();
});
byId("reset").addEventListener("click", async () => {
  if (mutationLocked || active !== null || !confirm("Remove saved Convo Caddy credentials? Unsaved entries remain if reset fails.") || !beginMutation()) return;
  try { const value = await request("/api/setup/credentials", {method:"DELETE",body:JSON.stringify({confirm:true})}); resetEvidence(); eraseDraft(); renderOverview(value); message.textContent = "Saved credentials removed."; }
  catch (error) { message.textContent = error.message; }
  finally { mutationLocked = false; syncControls(); }
});
byId("reload").addEventListener("click", async () => {
  if (mutationLocked || active !== null || initial?.mode !== "ready") return;
  const hasChanges = JSON.stringify(inputs.map(input => input.value)) !== initialDraft;
  if ((hasChanges && !confirm("Leave settings and discard unsaved changes?")) || !beginMutation()) return;
  backApproved = true;
  try { await request("/api/setup/reload", {method:"POST",body:"{}"}); }
  catch (error) {
    if (error.body) { refuseBack(error.message); return; }
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
      if (result.state === "blocked") {refuseBack("Could not return to the app. Your entries are still here; try again when the current operation finishes.");return;}
      if (result.state === "reloaded") return;
    } catch { /* Read-only reconciliation can retry after a lost or unreadable status. */ }
  }
  if (closeApproved) return;
  message.textContent = "Return could not be confirmed. Your entries are still here; editing stays locked while return is uncertain. Quit and reopen when ready to leave settings.";
});
// Quit and Back grant only document-local, explicitly approved unload authority.
syncControls();
request("/api/setup").then(value => { renderOverview(value); mutationLocked = false; syncControls(); }).catch(() => { message.textContent = "Saved setup could not be loaded. Quit and reopen Convo Caddy; no draft has been changed."; });
`;
