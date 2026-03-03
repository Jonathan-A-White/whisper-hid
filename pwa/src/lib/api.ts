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

export async function getModels(): Promise<{
  models: Array<{
    name: string;
    file: string;
    size_mb: number;
    description: string;
    downloaded: boolean;
    active: boolean;
  }>;
}> {
  const res = await whisperFetch("/models");
  return res.json();
}

export async function switchModel(
  modelName: string
): Promise<{ ok: boolean; model: string; model_size_mb: number }> {
  const res = await whisperFetch("/model", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: modelName }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.message || "Failed to switch model");
  }
  return res.json();
}

export async function benchmarkModels(options?: {
  models?: string[];
  duration?: number;
  use_vad?: boolean;
}): Promise<{
  audio_duration_sec: number;
  use_vad: boolean;
  vad_available: boolean;
  results: Array<{
    model: string;
    size_mb: number;
    text: string;
    inference_ms: number;
    speed_ratio: number;
    error: string | null;
  }>;
}> {
  const res = await whisperFetch("/models/benchmark", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options ?? {}),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.message || "Benchmark failed");
  }
  return res.json();
}

export async function getCorrections(): Promise<Record<string, string>> {
  const res = await whisperFetch("/corrections");
  return res.json();
}

export async function putCorrections(
  corrections: Record<string, string>
): Promise<Record<string, string>> {
  const res = await whisperFetch("/corrections", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(corrections),
  });
  return res.json();
}

// --- Whisper Server Settings ---

export interface WhisperSettings {
  noise_reduction: boolean;
}

export async function getWhisperSettings(): Promise<WhisperSettings> {
  const res = await whisperFetch("/settings");
  return res.json();
}

export async function putWhisperSettings(
  settings: Partial<WhisperSettings>
): Promise<WhisperSettings> {
  const res = await whisperFetch("/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });
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

const HID_TYPE_CHUNK_SIZE = 500;

export async function hidType(text: string, append: string = " ") {
  // Break large text into chunks to avoid overwhelming the HID service's
  // simple HTTP server. Send chunks sequentially; only the last chunk
  // gets the append suffix.
  if (text.length <= HID_TYPE_CHUNK_SIZE) {
    const res = await hidFetch("/type", {
      method: "POST",
      body: JSON.stringify({ text, append }),
    });
    if (res.status === 403) {
      throw new Error("AUTH_FAILED");
    }
    return res.json();
  }

  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += HID_TYPE_CHUNK_SIZE) {
    chunks.push(text.slice(i, i + HID_TYPE_CHUNK_SIZE));
  }

  let lastResult: unknown;
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    const res = await hidFetch("/type", {
      method: "POST",
      body: JSON.stringify({
        text: chunks[i],
        append: isLast ? append : "",
      }),
    });
    if (res.status === 403) {
      throw new Error("AUTH_FAILED");
    }
    lastResult = await res.json();
  }
  return lastResult;
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
