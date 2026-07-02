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

export interface PipelineDiagnostics {
  speech_detected?: boolean;
  final_text?: string;
  mic_bandwidth?: {
    verdict?: "narrowband" | "wideband" | "unknown";
    high_band_ratio?: number;
    peak_frame_high_ratio?: number;
    rolloff_hz?: number;
    reason?: string;
  };
  steps?: Array<{ step: string; error?: string; [key: string]: unknown }>;
}

export async function testPipeline(): Promise<PipelineDiagnostics> {
  const res = await whisperFetch("/debug/test-pipeline", { method: "POST" });
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

// --- Symbol replacements (spoken word -> symbol) ---

export type SymbolSpacing = "both" | "left" | "right" | "none";

export interface SymbolEntry {
  phrase: string;
  symbol: string;
  spacing: SymbolSpacing;
}

export interface SymbolConfig {
  enabled: boolean;
  entries: SymbolEntry[];
}

export async function getSymbols(): Promise<SymbolConfig> {
  const res = await whisperFetch("/symbols");
  return res.json();
}

export async function putSymbols(
  partial: Partial<SymbolConfig>
): Promise<SymbolConfig> {
  const res = await whisperFetch("/symbols", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(partial),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.message || "Failed to save symbols");
  }
  return res.json();
}

export async function resetSymbols(): Promise<SymbolConfig> {
  const res = await whisperFetch("/symbols/reset", { method: "POST" });
  return res.json();
}

// --- Speech cleanup (local LLM rewrites the transcript) ---

export interface CleanupStyleInfo {
  name: string;
  label: string;
  description: string;
}

export interface CleanupModelInfo {
  name: string;
  file: string;
  size_mb: number;
  description: string;
  downloaded: boolean;
  active: boolean;
}

export interface CleanupConfig {
  enabled: boolean;
  /** true when the llama-server is running with its model loaded */
  available: boolean;
  /** file name of the active model, or null when none is installed */
  model: string | null;
  models: CleanupModelInfo[];
  style: string;
  styles: CleanupStyleInfo[];
}

export async function getCleanup(): Promise<CleanupConfig> {
  const res = await whisperFetch("/cleanup");
  return res.json();
}

export async function putCleanup(partial: {
  enabled?: boolean;
  style?: string;
  model?: string;
}): Promise<CleanupConfig> {
  const res = await whisperFetch("/cleanup", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(partial),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.message || "Failed to save cleanup setting");
  }
  return res.json();
}

// --- Voice editing (LLM applies a spoken instruction to pending text) ---

export async function applyVoiceEdit(
  text: string,
  command: string
): Promise<{ text: string; duration_ms: number }> {
  const res = await whisperFetch("/edit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, command }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.message || "Edit failed");
  }
  return res.json();
}

// --- Correction suggestions (LLM scans recent transcripts) ---

export interface CorrectionSuggestion {
  wrong: string;
  right: string;
}

export async function suggestCorrections(): Promise<{
  suggestions: CorrectionSuggestion[];
  transcripts: number;
}> {
  const res = await whisperFetch("/corrections/suggest", { method: "POST" });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.message || "Suggestion request failed");
  }
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

export async function hidDevices(): Promise<{ devices: Array<{ address: string; name: string; connected: boolean }> }> {
  const res = await hidFetch("/devices");
  return res.json();
}

export async function hidConnect(address: string) {
  const res = await hidFetch("/connect", {
    method: "POST",
    body: JSON.stringify({ address }),
  });
  if (res.status === 403) {
    throw new Error("AUTH_FAILED");
  }
  return res.json();
}

export async function hidHeadsetMic(enabled: boolean): Promise<{
  ok: boolean;
  available: boolean;
  active: boolean;
  enabled: boolean;
  device?: string;
}> {
  const res = await hidFetch("/headset-mic", {
    method: "PUT",
    body: JSON.stringify({ enabled }),
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
