export interface TranscriptEntry {
  id: string;
  text: string;
  timestamp: number;
  pinned: boolean;
  model?: string;
  speedRatio?: number;
  audioDuration?: number;
  processingMs?: number;
}

export interface HidStatus {
  service: string;
  bluetooth: "connected" | "registered" | "reconnecting" | "failed" | "idle";
  device?: string;
  uptime_seconds?: number;
  reconnect_attempt?: number;
  reconnect_max?: number;
  next_retry_seconds?: number;
  failure_reason?: string;
  /** true while the service is typing (or has sends queued); absent on older APKs */
  typing?: boolean;
  keystroke_delay_ms?: number;
  headset_mic?: {
    available: boolean;
    active: boolean;
    /** false = released for other devices (Zoom mode); absent on older APKs */
    enabled?: boolean;
    device?: string;
  };
}

export interface BtDevice {
  address: string;
  name: string;
  connected: boolean;
}

export interface WhisperStatus {
  status: "ready" | "error";
  model?: string;
  model_size_mb?: number;
  recording?: boolean;
  message?: string;
  /** true when the cleanup llama-server is up with its model loaded */
  cleanup_available?: boolean;
  cleanup_mode?: boolean;
  cleanup_style?: string;
  /** Active target app; absent on servers older than 1.9.0 */
  target?: TargetMode;
  target_newline_mode?: NewlineMode;
  /** Android audio source used for mic capture (see WhisperSettings) */
  mic_audio_source?: string;
  /** false when the termux-api binary is missing, so only "mic" is possible */
  mic_audio_source_selectable?: boolean;
}

export interface ModelInfo {
  name: string;
  file: string;
  size_mb: number;
  description: string;
  downloaded: boolean;
  active: boolean;
}

export interface LogEntry {
  ts: number;
  level: string;
  msg: string;
}

/** How a line break is typed on the host — see TargetMode. */
export type NewlineMode = "enter" | "ctrl_j" | "backslash_enter";

/** Which app the keystrokes are going to (whisper server: GET/PUT /target). */
export type TargetMode = "plain" | "claude" | "codex";

export interface TargetInfo {
  name: TargetMode;
  label: string;
  description: string;
  newline_mode: NewlineMode;
}

export interface TargetState {
  target: TargetMode;
  newline_mode: NewlineMode;
  targets: TargetInfo[];
}

export interface Settings {
  editBeforeSend: boolean;
  appendNewline: boolean;
  appendSpace: boolean;
  newlineAfterEnd: boolean;
  /** @deprecated Superseded by the server-side target mode (TargetMode).
   *  Only read once, to migrate an existing phone to target "claude". */
  claudeCodeNewlines?: boolean;
  /** Set after the one-time claudeCodeNewlines -> target migration. */
  targetMigrated?: boolean;
  keystrokeDelay: number;
  whisperModel: string;
  language: string;
}

export const DEFAULT_SETTINGS: Settings = {
  editBeforeSend: false,
  appendNewline: false,
  appendSpace: true,
  newlineAfterEnd: false,
  keystrokeDelay: 10,
  whisperModel: "base.en",
  language: "en",
};

export interface BenchmarkResult {
  model: string;
  size_mb: number;
  text: string;
  inference_ms: number;
  speed_ratio: number;
  error: string | null;
}

export interface BenchmarkResponse {
  audio_duration_sec: number;
  use_vad: boolean;
  vad_available: boolean;
  results: BenchmarkResult[];
}

export type Tab = "talk" | "history" | "settings";

export interface QueuedText {
  id: string;
  text: string;
  status: "pending" | "sent" | "failed";
}
