/**
 * Binary files: a keyboard can only type text, so the bytes are typed as
 * base64 in lines of a fixed width, between a header that says in plain words
 * what follows and how to get the file back, and a footer. Pure logic; the
 * header is ASCII only, so any keyboard layout types it as it is.
 */

/** Base64 characters per typed line. */
export const BASE64_LINE_WIDTH = 64;

const BEGIN = "-----BEGIN BASE64-----";
const END = "-----END BASE64-----";

// btoa wants a binary string; 3 bytes make 4 characters, so a slice that is a
// multiple of 3 bytes encodes to pieces that join into the whole
const SLICE = 3 * 8192;

export function toBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += SLICE) {
    parts.push(btoa(String.fromCharCode(...bytes.subarray(i, i + SLICE))));
  }
  return parts.join("");
}

export function base64Lines(bytes: Uint8Array): string[] {
  const text = toBase64(bytes);
  const lines: string[] = [];
  for (let i = 0; i < text.length; i += BASE64_LINE_WIDTH) {
    lines.push(text.slice(i, i + BASE64_LINE_WIDTH));
  }
  return lines;
}

/** SHA-256 as 64 lower-case hex digits (needs a secure context: Pages is https). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The name the rebuild commands use: letters, digits, dot, dash and
 * underscore only, so it is safe inside quotes in bash and PowerShell, and it
 * cannot start with a dash (an option) or be only dots.
 */
export function safeFileName(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]/gu, "_").replace(/^-/, "_");
  return /^\.*$/.test(safe) ? "file" : safe;
}

/** A name for the header: printable ASCII only, whatever the file is called. */
export function asciiName(name: string): string {
  return name.replace(/[^\x20-\x7e]/gu, "?");
}

export function formatBytes(n: number): string {
  if (n === 1) return "1 byte";
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export interface BinaryBlockInput {
  name: string;
  bytes: Uint8Array;
  sha256: string;
  /** one plain line about what was done to the file first, if anything */
  note?: string;
}

/** The one line that rebuilds the file in bash and checks its SHA-256. */
function bashLine(saved: string, out: string, sha256: string): string {
  return (
    `sed -n '/^${BEGIN}/,/^${END}/p' ${saved} | grep -v '^-----' | tr -d '\\r' | base64 -d > ${out}` +
    ` && echo '${sha256}  ${out}' | sha256sum -c -`
  );
}

/** The one line that rebuilds the file in Windows PowerShell and checks its SHA-256. */
function powerShellLine(saved: string, out: string, sha256: string): string {
  return (
    `$t=[IO.File]::ReadAllText((Join-Path $PWD '${saved}'));` +
    ` $b=[Convert]::FromBase64String(($t -replace '(?sm)^.*?^${BEGIN}','' -replace '(?sm)^${END}.*$',''));` +
    ` [IO.File]::WriteAllBytes((Join-Path $PWD '${out}'),$b);` +
    ` if((Get-FileHash '${out}' -Algorithm SHA256).Hash -eq '${sha256}'){'SHA-256 OK'}else{'SHA-256 MISMATCH'}`
  );
}

export function binaryBlock({ name, bytes, sha256, note }: BinaryBlockInput): string {
  const out = safeFileName(name);
  const saved = `${out}.b64.txt`;
  const lines = [
    "=== BINARY FILE, typed as base64 ===",
    "This is a binary file, not text. It was typed as base64 because a keyboard can only type text.",
    `file name: ${asciiName(name)}`,
    `size: ${formatBytes(bytes.length)}`,
    `sha256: ${sha256}`,
    ...(note ? [`note: ${note}`] : []),
    "The base64 is between the BEGIN BASE64 and END BASE64 lines below.",
    `To get the file back: save this whole message as ${saved}, then run ONE of these lines in the folder you saved it in. It writes ${out} and checks its SHA-256 against the one above.`,
    "bash:",
    bashLine(saved, out, sha256),
    "PowerShell:",
    powerShellLine(saved, out, sha256),
    BEGIN,
    ...base64Lines(bytes),
    END,
    `=== END OF BINARY FILE ${asciiName(name)} ===`,
    "",
  ];
  return lines.join("\n");
}

/** The whole message to type for a file: hashes the bytes, then builds the block. */
export async function typedBinaryText(
  name: string,
  bytes: Uint8Array,
  note?: string
): Promise<string> {
  return binaryBlock({ name, bytes, sha256: await sha256Hex(bytes), note });
}
