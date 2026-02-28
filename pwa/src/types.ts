export interface TranscriptEntry {
  id: string;
  text: string;
  timestamp: number;
  pinned: boolean;
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
}

export interface WhisperStatus {
  status: "ready" | "error";
  model?: string;
  model_size_mb?: number;
  recording?: boolean;
  message?: string;
}

export interface LogEntry {
  ts: number;
  level: string;
  msg: string;
}

export interface Settings {
  editBeforeSend: boolean;
  appendNewline: boolean;
  appendSpace: boolean;
  keystrokeDelay: number;
  whisperModel: string;
  language: string;
}

export const DEFAULT_SETTINGS: Settings = {
  editBeforeSend: false,
  appendNewline: false,
  appendSpace: true,
  keystrokeDelay: 10,
  whisperModel: "base.en",
  language: "en",
};

export type Tab = "talk" | "history" | "settings";

export interface QueuedText {
  id: string;
  text: string;
  status: "pending" | "sent" | "failed";
}
