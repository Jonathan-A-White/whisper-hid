import { useEffect, useState } from "react";
import {
  whisperStatus,
  hidStatus,
  hasToken,
  testPipeline,
} from "../lib/api";
import type { HidStatus } from "../types";

const BOOTSTRAP_CMD =
  "curl -fsSL https://raw.githubusercontent.com/Jonathan-A-White/whisper-hid/main/scripts/bootstrap.sh | bash";
const TERMUX_URL = "https://f-droid.org/en/packages/com.termux/";
const TERMUX_API_URL = "https://f-droid.org/en/packages/com.termux.api/";
const RELEASES_URL = "https://github.com/Jonathan-A-White/whisper-hid/releases";

interface SetupWizardProps {
  onClose?: () => void;
}

function CopyBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable (e.g. insecure context) — leave text selectable
    }
  };

  return (
    <div className="mt-2">
      <code className="block bg-gray-950 border border-gray-700 rounded px-3 py-2 text-xs text-sky-300 break-all select-all">
        {text}
      </code>
      <button
        onClick={copy}
        className="mt-2 w-full py-2 rounded bg-sky-600 text-white text-sm font-medium active:bg-sky-700"
      >
        {copied ? "Copied!" : "Copy command"}
      </button>
    </div>
  );
}

function StepCard({
  index,
  title,
  done,
  active,
  children,
}: {
  index: number;
  title: string;
  done: boolean;
  active: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div
      className={`rounded-lg border p-4 ${
        done
          ? "border-green-800 bg-green-950/30"
          : active
            ? "border-sky-700 bg-gray-900"
            : "border-gray-800 bg-gray-950"
      }`}
    >
      <div className="flex items-center gap-3">
        <span
          className={`flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-sm font-bold ${
            done
              ? "bg-green-600 text-white"
              : active
                ? "bg-sky-600 text-white"
                : "bg-gray-800 text-gray-500"
          }`}
        >
          {done ? "✓" : index}
        </span>
        <h3
          className={`text-sm font-semibold ${
            done ? "text-green-400" : active ? "text-white" : "text-gray-500"
          }`}
        >
          {title}
        </h3>
      </div>
      {!done && active && children && (
        <div className="mt-3 ml-10 text-sm text-gray-400">{children}</div>
      )}
    </div>
  );
}

export function SetupWizard({ onClose }: SetupWizardProps) {
  const [whisperOk, setWhisperOk] = useState(false);
  const [hidOk, setHidOk] = useState(false);
  const [btState, setBtState] = useState<HidStatus["bluetooth"] | null>(null);
  const [btDevice, setBtDevice] = useState<string | null>(null);
  const [micTesting, setMicTesting] = useState(false);
  const [micResult, setMicResult] = useState<string | null>(null);
  const [micOk, setMicOk] = useState<boolean | null>(null);

  const tokenOk = hasToken();

  // Poll both services every 3s. Both /status endpoints are unauthenticated,
  // so detection works before the user has an auth token.
  useEffect(() => {
    const poll = async () => {
      try {
        await whisperStatus();
        setWhisperOk(true);
      } catch {
        setWhisperOk(false);
      }
      try {
        const hid = await hidStatus();
        setHidOk(true);
        setBtState(hid.bluetooth ?? null);
        setBtDevice(hid.device ?? null);
      } catch {
        setHidOk(false);
        setBtState(null);
        setBtDevice(null);
      }
    };
    poll();
    const id = setInterval(poll, 3000);
    return () => clearInterval(id);
  }, []);

  const btOk = btState === "connected";

  const steps = [
    { done: whisperOk, title: "Install Termux and Termux:API" },
    { done: whisperOk, title: "Run the setup command in Termux" },
    { done: hidOk, title: "Install the Whisper Keyboard app" },
    { done: tokenOk, title: "Connect this page to the app" },
    { done: btOk, title: "Pair your laptop via Bluetooth" },
  ];
  const activeIndex = steps.findIndex((s) => !s.done);
  const allDone = activeIndex === -1;

  const runMicTest = async () => {
    setMicTesting(true);
    setMicResult(null);
    setMicOk(null);
    try {
      const diag = await testPipeline();
      const failed = diag.steps?.find((s) => s.error);
      if (failed) {
        setMicOk(false);
        setMicResult(`${failed.step}: ${failed.error}`);
      } else if (diag.speech_detected) {
        setMicOk(true);
        setMicResult(`Heard: "${diag.final_text}"`);
      } else {
        setMicOk(false);
        setMicResult(
          "No speech detected. Make sure Termux:API has microphone permission and try speaking louder."
        );
      }
    } catch {
      setMicOk(false);
      setMicResult("Test failed — is the Whisper server running?");
    } finally {
      setMicTesting(false);
    }
  };

  return (
    <div className="min-h-[100dvh] bg-black p-4 pb-8">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-lg font-bold text-white">Setup</h1>
        {onClose && (
          <button onClick={onClose} className="text-sm text-sky-400 py-2 px-3">
            Close
          </button>
        )}
      </div>
      <p className="text-xs text-gray-500 mb-4">
        Steps are detected automatically — this page updates as each one
        completes.
      </p>

      <div className="space-y-3">
        <StepCard
          index={1}
          title={steps[0].title}
          done={steps[0].done}
          active={activeIndex === 0}
        >
          <p>Install both apps from F-Droid (not Google Play):</p>
          <div className="mt-2 space-y-2">
            <a
              href={TERMUX_URL}
              target="_blank"
              rel="noreferrer"
              className="block w-full py-2 rounded bg-gray-800 text-sky-400 text-sm text-center"
            >
              Get Termux
            </a>
            <a
              href={TERMUX_API_URL}
              target="_blank"
              rel="noreferrer"
              className="block w-full py-2 rounded bg-gray-800 text-sky-400 text-sm text-center"
            >
              Get Termux:API
            </a>
          </div>
          <p className="mt-2 text-xs text-gray-500">
            Then grant Termux:API microphone permission: Android Settings &gt;
            Apps &gt; Termux:API &gt; Permissions.
          </p>
          <p className="mt-2 text-xs text-gray-600">
            Done installing? Continue with step 2 — both steps are marked
            complete once the Whisper server is running.
          </p>
        </StepCard>

        <StepCard
          index={2}
          title={steps[1].title}
          done={steps[1].done}
          active={activeIndex === 1}
        >
          <p>
            Open Termux, paste this command, and press Enter. It installs
            everything, builds Whisper (takes a few minutes), downloads the
            app, and starts the server:
          </p>
          <CopyBlock text={BOOTSTRAP_CMD} />
          <p className="mt-2 text-xs text-gray-600">
            Waiting for the Whisper server on localhost:9876...
          </p>
        </StepCard>

        <StepCard
          index={3}
          title={steps[2].title}
          done={steps[2].done}
          active={activeIndex === 2}
        >
          <p>
            The setup command downloads the APK and opens the Android
            installer — accept the install prompt. If that didn't happen,
            download it manually:
          </p>
          <a
            href={RELEASES_URL}
            target="_blank"
            rel="noreferrer"
            className="block mt-2 w-full py-2 rounded bg-gray-800 text-sky-400 text-sm text-center"
          >
            Download APK from GitHub Releases
          </a>
          <p className="mt-2 text-xs text-gray-600">
            Then open the Whisper Keyboard app once so its service starts.
            Waiting for the HID service on localhost:9877...
          </p>
        </StepCard>

        <StepCard
          index={4}
          title={steps[3].title}
          done={steps[3].done}
          active={activeIndex === 3}
        >
          <p>
            Open the <strong>Whisper Keyboard</strong> app and tap{" "}
            <strong>&quot;Open Whisper Keyboard&quot;</strong>. That reopens
            this page with a fresh auth token.
          </p>
        </StepCard>

        <StepCard
          index={5}
          title={steps[4].title}
          done={steps[4].done}
          active={activeIndex === 4}
        >
          <p>
            On your laptop, open Bluetooth settings and pair with{" "}
            <strong>&quot;Whisper Keyboard&quot;</strong>. The laptop will see
            it as a regular Bluetooth keyboard.
          </p>
          {hidOk && (
            <p className="mt-2 text-xs text-gray-500">
              Bluetooth state: {btState ?? "unknown"}
              {btState === "registered" && " — waiting for the laptop to pair"}
            </p>
          )}
        </StepCard>

        {allDone && (
          <div className="rounded-lg border border-green-700 bg-green-950/40 p-4">
            <h3 className="text-sm font-semibold text-green-400">
              Setup complete{btDevice ? ` — connected to ${btDevice}` : ""}
            </h3>
            <p className="mt-2 text-sm text-gray-400">
              Optionally run a microphone test: it records 3 seconds of audio
              and transcribes it. Say something after tapping the button.
            </p>
            <button
              onClick={runMicTest}
              disabled={micTesting}
              className="mt-3 w-full py-2 rounded bg-gray-800 text-sky-400 text-sm font-medium disabled:opacity-50"
            >
              {micTesting ? "Recording 3s... speak now" : "Test microphone"}
            </button>
            {micResult && (
              <p
                className={`mt-2 text-sm ${micOk ? "text-green-400" : "text-red-400"}`}
              >
                {micResult}
              </p>
            )}
            {onClose && (
              <button
                onClick={onClose}
                className="mt-3 w-full py-3 rounded bg-sky-600 text-white text-sm font-bold"
              >
                Start talking
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
