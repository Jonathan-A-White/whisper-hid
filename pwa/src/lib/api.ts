const WHISPER_BASE = "http://localhost:9876";
const HID_BASE = "http://localhost:9877";

let authToken: string | null = null;

export function initAuth(): void {
  // Check URL for token first
  const params = new URLSearchParams(window.location.search);
  const urlToken = params.get("token");
  if (urlToken) {
    authToken = urlToken;
    localStorage.setItem("whisper_auth_token", urlToken);
    // Strip token from URL bar
    window.history.replaceState({}, "", window.location.pathname);
    return;
  }
  // Fall back to stored token
  authToken = localStorage.getItem("whisper_auth_token");
}

export function getToken(): string | null {
  return authToken;
}

export function clearToken(): void {
  authToken = null;
  localStorage.removeItem("whisper_auth_token");
}

export function hasToken(): boolean {
  return authToken !== null && authToken.length > 0;
}

async function hidFetch(
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };
  if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }
  return fetch(`${HID_BASE}${path}`, { ...options, headers });
}

async function whisperFetch(
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  return fetch(`${WHISPER_BASE}${path}`, options);
}

// --- Whisper Server API ---

export async function whisperStatus() {
  const res = await whisperFetch("/status");
  return res.json();
}

export async function whisperLogs() {
  const res = await whisperFetch("/logs");
  return res.json();
}

export async function transcribeStart() {
  const res = await whisperFetch("/transcribe/start", { method: "POST" });
  return res.json();
}

export async function transcribeStop() {
  const res = await whisperFetch("/transcribe/stop", { method: "POST" });
  return res.json();
}

// --- HID Service API ---

export async function hidStatus() {
  const res = await hidFetch("/status");
  return res.json();
}

export async function hidLogs() {
  const res = await hidFetch("/logs");
  return res.json();
}

export async function hidType(text: string, append: string = " ") {
  const res = await hidFetch("/type", {
    method: "POST",
    body: JSON.stringify({ text, append }),
  });
  if (res.status === 403) {
    throw new Error("AUTH_FAILED");
  }
  return res.json();
}

export async function hidBackspace(count: number) {
  const res = await hidFetch("/backspace", {
    method: "POST",
    body: JSON.stringify({ count }),
  });
  if (res.status === 403) {
    throw new Error("AUTH_FAILED");
  }
  return res.json();
}

export async function hidRestart() {
  const res = await hidFetch("/restart", { method: "POST" });
  if (res.status === 403) {
    throw new Error("AUTH_FAILED");
  }
  return res.json();
}
