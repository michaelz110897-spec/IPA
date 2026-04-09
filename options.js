// Options page logic. Reads/writes the Anthropic API key in
// chrome.storage.local under the key "anthropicApiKey".

const STORAGE_KEY = "anthropicApiKey";

const keyInput = document.getElementById("key");
const saveBtn = document.getElementById("save");
const showBtn = document.getElementById("show");
const clearBtn = document.getElementById("clear");
const statusEl = document.getElementById("status");

function setStatus(text, kind) {
  statusEl.textContent = text || "";
  statusEl.className = "status" + (kind ? " " + kind : "");
}

async function loadKey() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  const key = data && data[STORAGE_KEY];
  if (key) {
    keyInput.value = key;
    setStatus("Key loaded.", "ok");
  }
}

saveBtn.addEventListener("click", async () => {
  const key = (keyInput.value || "").trim();
  if (!key) {
    setStatus("Enter a key first.", "err");
    return;
  }
  if (!key.startsWith("sk-ant-")) {
    setStatus("That doesn't look like an Anthropic key (should start with sk-ant-).", "err");
    return;
  }
  await chrome.storage.local.set({ [STORAGE_KEY]: key });
  setStatus("Saved.", "ok");
});

showBtn.addEventListener("click", () => {
  const showing = keyInput.type === "text";
  keyInput.type = showing ? "password" : "text";
  showBtn.textContent = showing ? "Show" : "Hide";
});

clearBtn.addEventListener("click", async () => {
  await chrome.storage.local.remove(STORAGE_KEY);
  keyInput.value = "";
  setStatus("Cleared.", "ok");
});

loadKey();
