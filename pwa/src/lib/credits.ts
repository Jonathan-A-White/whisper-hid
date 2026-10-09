/**
 * Everything this project stands on, for the About screen and the README.
 *
 * Adding a library, model, service or borrowed idea means adding it here in
 * the same commit: credits.test.ts reads pwa/package.json,
 * app/build.gradle.kts and scripts/requirements.txt and fails when a
 * dependency is not named in `packages`, fails when a `packages` id is no
 * longer a dependency (removing a library means removing its credit in the
 * same commit; credits without `packages` are exempt), fails when a bundled
 * font or data file is not named in `files`, and checks the README's Credits
 * section lists every entry (the README copy is kept by hand, in the same
 * order).
 */

export type CreditKind = "idea" | "app" | "pwa" | "server" | "model" | "tool" | "service";

export interface Credit {
  /** Shown as the link text. Never a raw URL: it breaks mid-word on a phone. */
  name: string;
  kind: CreditKind;
  url: string;
  /** What it is used for here. */
  use: string;
  license: string;
  licenseUrl: string;
  /** What we changed, or "None" when we use it as published. */
  changes: string;
  /** Dependency ids this entry covers: "npm:x", "gradle:group:artifact", "pip:x". */
  packages?: string[];
  /**
   * Bundled font or data files this entry covers, repo-relative: a file path,
   * or a directory ending in "/". The app ships none today.
   */
  files?: string[];
}

export const NEWTON_QUOTE = {
  text: "If I have seen further it is by standing on the shoulders of Giants.",
  by: "Isaac Newton, in a letter to Robert Hooke, 1675",
} as const;

export const WHY_WE_CREDIT =
  "Whisper Keyboard only works because of the people and projects below, so each one is named here with what we use it for, its licence and anything we changed.";

export const KIND_LABELS: Record<CreditKind, string> = {
  idea: "Ideas and tools we build with",
  pwa: "This screen (the PWA)",
  app: "The Android app",
  server: "The Termux server",
  model: "Speech and language models",
  tool: "On the phone",
  service: "Services",
};

const APACHE = "https://www.apache.org/licenses/LICENSE-2.0";
const GPL3 = "https://www.gnu.org/licenses/gpl-3.0.html";

export const CREDITS: Credit[] = [
  // Borrowed ideas and the tools the work is made with
  {
    name: "Beads",
    kind: "idea",
    url: "https://github.com/steveyegge/beads",
    use: "Steve Yegge's issue tracker for AI agents. This project is built through a software factory that tracks every story as a bead.",
    license: "MIT",
    licenseUrl: "https://github.com/steveyegge/beads/blob/main/LICENSE",
    changes: "None. We use the tool and its idea as published.",
  },
  {
    name: "Gas Town",
    kind: "idea",
    url: "https://github.com/steveyegge/gastown",
    use: "Steve Yegge's multi-agent workspace manager. The factory's roles (a mayor who plans, builders who work one story each) borrow its ideas.",
    license: "MIT",
    licenseUrl: "https://github.com/steveyegge/gastown/blob/main/LICENSE",
    changes: "Ideas only; none of its code is included here.",
  },
  {
    name: "Claude Code",
    kind: "idea",
    url: "https://www.anthropic.com/claude-code",
    use: "Anthropic's coding agent. Much of this code was written with it, and the keyboard is built to dictate into it.",
    license: "Anthropic Commercial Terms",
    licenseUrl: "https://www.anthropic.com/legal/commercial-terms",
    changes: "None.",
  },

  // PWA
  {
    name: "React and React DOM",
    kind: "pwa",
    url: "https://react.dev",
    use: "The user interface library this app is written in.",
    license: "MIT",
    licenseUrl: "https://github.com/facebook/react/blob/main/LICENSE",
    changes: "None.",
    packages: ["npm:react", "npm:react-dom"],
  },
  {
    name: "Vite",
    kind: "pwa",
    url: "https://vite.dev",
    use: "Builds and bundles the PWA.",
    license: "MIT",
    licenseUrl: "https://github.com/vitejs/vite/blob/main/LICENSE",
    changes: "None.",
    packages: ["npm:vite"],
  },
  {
    name: "@vitejs/plugin-react",
    kind: "pwa",
    url: "https://github.com/vitejs/vite-plugin-react",
    use: "Lets Vite compile the React code.",
    license: "MIT",
    licenseUrl: "https://github.com/vitejs/vite-plugin-react/blob/main/LICENSE",
    changes: "None.",
    packages: ["npm:@vitejs/plugin-react"],
  },
  {
    name: "vite-plugin-pwa and Workbox",
    kind: "pwa",
    url: "https://github.com/vite-pwa/vite-plugin-pwa",
    use: "Makes the PWA installable and offline-capable, and generates its service worker with Google's Workbox.",
    license: "MIT (vite-plugin-pwa), Apache-2.0 (Workbox)",
    licenseUrl: "https://github.com/vite-pwa/vite-plugin-pwa/blob/main/LICENSE",
    changes: "None.",
    packages: ["npm:vite-plugin-pwa"],
  },
  {
    name: "Tailwind CSS",
    kind: "pwa",
    url: "https://tailwindcss.com",
    use: "The styling of every screen.",
    license: "MIT",
    licenseUrl: "https://github.com/tailwindlabs/tailwindcss/blob/main/LICENSE",
    changes: "None.",
    packages: ["npm:tailwindcss"],
  },
  {
    name: "PostCSS",
    kind: "pwa",
    url: "https://postcss.org",
    use: "Runs Tailwind when the PWA is built.",
    license: "MIT",
    licenseUrl: "https://github.com/postcss/postcss/blob/main/LICENSE",
    changes: "None.",
    packages: ["npm:postcss"],
  },
  {
    name: "Autoprefixer",
    kind: "pwa",
    url: "https://github.com/postcss/autoprefixer",
    use: "Adds browser prefixes to the CSS at build time.",
    license: "MIT",
    licenseUrl: "https://github.com/postcss/autoprefixer/blob/main/LICENSE",
    changes: "None.",
    packages: ["npm:autoprefixer"],
  },
  {
    name: "TypeScript",
    kind: "pwa",
    url: "https://www.typescriptlang.org",
    use: "The language the PWA is written in.",
    license: "Apache-2.0",
    licenseUrl: "https://github.com/microsoft/TypeScript/blob/main/LICENSE.txt",
    changes: "None.",
    packages: ["npm:typescript"],
  },
  {
    name: "DefinitelyTyped",
    kind: "pwa",
    url: "https://github.com/DefinitelyTyped/DefinitelyTyped",
    use: "The type definitions for React (@types/react, @types/react-dom).",
    license: "MIT",
    licenseUrl: "https://github.com/DefinitelyTyped/DefinitelyTyped/blob/master/LICENSE",
    changes: "None.",
    packages: ["npm:@types/react", "npm:@types/react-dom"],
  },
  {
    name: "Vitest",
    kind: "pwa",
    url: "https://vitest.dev",
    use: "Runs the PWA's tests.",
    license: "MIT",
    licenseUrl: "https://github.com/vitest-dev/vitest/blob/main/LICENSE",
    changes: "None.",
    packages: ["npm:vitest"],
  },

  // Android app
  {
    name: "Android Open Source Project",
    kind: "app",
    url: "https://source.android.com",
    use: "The Android platform, including the BluetoothHidDevice API that lets the phone act as a Bluetooth keyboard, and the Android Gradle Plugin that builds the app.",
    license: "Apache-2.0",
    licenseUrl: "https://source.android.com/docs/setup/about/licenses",
    changes: "None.",
  },
  {
    name: "AndroidX Core KTX",
    kind: "app",
    url: "https://developer.android.com/jetpack/androidx/releases/core",
    use: "Kotlin extensions for the Android framework, used by the Bluetooth service.",
    license: "Apache-2.0",
    licenseUrl: APACHE,
    changes: "None.",
    packages: ["gradle:androidx.core:core-ktx"],
  },
  {
    name: "AndroidX AppCompat",
    kind: "app",
    url: "https://developer.android.com/jetpack/androidx/releases/appcompat",
    use: "Backwards-compatible activities and themes for the app's launcher screen.",
    license: "Apache-2.0",
    licenseUrl: APACHE,
    changes: "None.",
    packages: ["gradle:androidx.appcompat:appcompat"],
  },
  {
    name: "Material Components for Android",
    kind: "app",
    url: "https://github.com/material-components/material-components-android",
    use: "Material Design widgets for the app's launcher screen.",
    license: "Apache-2.0",
    licenseUrl: "https://github.com/material-components/material-components-android/blob/master/LICENSE",
    changes: "None.",
    packages: ["gradle:com.google.android.material:material"],
  },
  {
    name: "Kotlin",
    kind: "app",
    url: "https://kotlinlang.org",
    use: "The language the Android app is written in.",
    license: "Apache-2.0",
    licenseUrl: "https://github.com/JetBrains/kotlin/blob/master/license/LICENSE.txt",
    changes: "None.",
  },
  {
    name: "Gradle",
    kind: "app",
    url: "https://gradle.org",
    use: "Builds the Android app and runs its tests.",
    license: "Apache-2.0",
    licenseUrl: "https://github.com/gradle/gradle/blob/master/LICENSE",
    changes: "None.",
  },
  {
    name: "JUnit 4",
    kind: "app",
    url: "https://junit.org/junit4/",
    use: "Tests the Android app (key mapping, link warm-up, crash records).",
    license: "EPL-1.0",
    licenseUrl: "https://www.eclipse.org/legal/epl-v10.html",
    changes: "None.",
    packages: ["gradle:junit:junit"],
  },

  // Termux server
  {
    name: "Flask",
    kind: "server",
    url: "https://flask.palletsprojects.com",
    use: "The web framework of the Whisper server on the phone.",
    license: "BSD-3-Clause",
    licenseUrl: "https://github.com/pallets/flask/blob/main/LICENSE.txt",
    changes: "None.",
    packages: ["pip:flask"],
  },
  {
    name: "NumPy",
    kind: "server",
    url: "https://numpy.org",
    use: "Audio feature extraction and decoding maths for Parakeet.",
    license: "BSD-3-Clause",
    licenseUrl: "https://github.com/numpy/numpy/blob/main/LICENSE.txt",
    changes: "None. Installed from Termux's packages, not pip.",
    packages: ["pip:numpy"],
  },
  {
    name: "ONNX Runtime",
    kind: "server",
    url: "https://onnxruntime.ai",
    use: "Runs the Parakeet model on the phone's processor.",
    license: "MIT",
    licenseUrl: "https://github.com/microsoft/onnxruntime/blob/main/LICENSE",
    changes: "None. Installed from Termux's packages, not pip.",
    packages: ["pip:onnxruntime"],
  },
  {
    name: "sherpa-onnx",
    kind: "server",
    url: "https://github.com/k2-fsa/sherpa-onnx",
    use: "Where it can be installed (laptops, CI) it is the speech decoder. On the phone our own port of its Parakeet reference script is used instead, and its release page hosts the model download.",
    license: "Apache-2.0",
    licenseUrl: "https://github.com/k2-fsa/sherpa-onnx/blob/master/LICENSE",
    changes: "scripts/parakeet_onnx.py is a port of its Parakeet reference script to plain NumPy and ONNX Runtime, checked to give byte-identical transcripts.",
    packages: ["pip:sherpa-onnx"],
  },
  {
    name: "kaldi-native-fbank",
    kind: "server",
    url: "https://github.com/csukuangfj/kaldi-native-fbank",
    use: "The filterbank feature settings the Parakeet model was exported with, which our port reproduces exactly.",
    license: "Apache-2.0",
    licenseUrl: "https://github.com/csukuangfj/kaldi-native-fbank/blob/master/LICENSE",
    changes: "Settings matched in Python; none of its code is included.",
  },
  {
    name: "librosa",
    kind: "server",
    url: "https://librosa.org",
    use: "The mel scale (Slaney) the Parakeet features are built on.",
    license: "ISC",
    licenseUrl: "https://github.com/librosa/librosa/blob/main/LICENSE.md",
    changes: "The formula is re-implemented; none of its code is included.",
  },

  // Models
  {
    name: "NVIDIA Parakeet TDT 0.6B v2",
    kind: "model",
    url: "https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2",
    use: "The speech-to-text model that turns your voice into text, entirely on the phone.",
    license: "CC BY 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
    changes: "We use the int8-quantised ONNX export published by sherpa-onnx, not NVIDIA's original NeMo checkpoint.",
  },
  {
    name: "OpenAI Whisper",
    kind: "model",
    url: "https://github.com/openai/whisper",
    use: "The speech model this keyboard was first built on, and the source of its name. Parakeet replaced it in October 2026.",
    license: "MIT",
    licenseUrl: "https://github.com/openai/whisper/blob/main/LICENSE",
    changes: "None; no longer included.",
  },
  {
    name: "whisper.cpp",
    kind: "model",
    url: "https://github.com/ggml-org/whisper.cpp",
    use: "Ran Whisper on the phone until Parakeet replaced it in October 2026.",
    license: "MIT",
    licenseUrl: "https://github.com/ggml-org/whisper.cpp/blob/master/LICENSE",
    changes: "None; no longer included.",
  },
  {
    name: "llama.cpp",
    kind: "model",
    url: "https://github.com/ggml-org/llama.cpp",
    use: "Runs the small language model that tidies up what you said (filler words, punctuation, styles, voice edits), on the phone.",
    license: "MIT",
    licenseUrl: "https://github.com/ggml-org/llama.cpp/blob/master/LICENSE",
    changes: "Built from source in Termux with -DGGML_NATIVE=OFF; no code changes.",
  },
  {
    name: "Qwen3",
    kind: "model",
    url: "https://huggingface.co/Qwen/Qwen3-1.7B",
    use: "Alibaba's Qwen3 1.7B (the default) and 4B models do the cleanup rewrite.",
    license: "Apache-2.0",
    licenseUrl: "https://huggingface.co/Qwen/Qwen3-1.7B/blob/main/LICENSE",
    changes: "Used as the 4-bit (Q4_K_M) GGUF files converted by Unsloth, with a prompt of our own.",
  },
  {
    name: "Qwen3.5",
    kind: "model",
    url: "https://huggingface.co/Qwen/Qwen3.5-2B",
    use: "Alibaba's Qwen3.5 2B and 0.8B models, offered as faster options for the cleanup rewrite.",
    license: "Apache-2.0",
    licenseUrl: "https://huggingface.co/Qwen/Qwen3.5-2B/blob/main/LICENSE",
    changes: "Used as the 4-bit (Q4_K_M) GGUF files converted by Unsloth, with a prompt of our own.",
  },
  {
    name: "Unsloth",
    kind: "model",
    url: "https://huggingface.co/unsloth",
    use: "Publishes the GGUF conversions of the Qwen models that the phone downloads.",
    license: "Apache-2.0 (the model files carry the Qwen licence)",
    licenseUrl: "https://huggingface.co/unsloth/Qwen3-1.7B-GGUF",
    changes: "None.",
  },

  // On the phone
  {
    name: "Termux",
    kind: "tool",
    url: "https://termux.dev",
    use: "The Linux environment on the phone where the Whisper server and the language model run.",
    license: "GPL-3.0",
    licenseUrl: "https://github.com/termux/termux-app/blob/master/LICENSE.md",
    changes: "None.",
  },
  {
    name: "Termux:API",
    kind: "tool",
    url: "https://github.com/termux/termux-api",
    use: "Gives the server access to the microphone.",
    license: "GPL-3.0",
    licenseUrl: GPL3,
    changes: "None. The server calls its MicRecorder service directly when a non-default audio source is chosen.",
  },
  {
    name: "FFmpeg",
    kind: "tool",
    url: "https://ffmpeg.org",
    use: "Converts and slices the recording before it is transcribed.",
    license: "LGPL-2.1+ / GPL-2.0+ (depends on the build)",
    licenseUrl: "https://ffmpeg.org/legal.html",
    changes: "None. Installed from Termux's packages.",
  },

  // Services
  {
    name: "GitHub",
    kind: "service",
    url: "https://github.com",
    use: "Hosts the source, builds the Android app and this PWA, and serves both (GitHub Pages and Releases).",
    license: "GitHub Terms of Service",
    licenseUrl: "https://docs.github.com/en/site-policy/github-terms/github-terms-of-service",
    changes: "None.",
  },
  {
    name: "Hugging Face",
    kind: "service",
    url: "https://huggingface.co",
    use: "Where the phone downloads the cleanup language models.",
    license: "Hugging Face Terms of Service",
    licenseUrl: "https://huggingface.co/terms-of-service",
    changes: "None.",
  },
];

/** Every dependency id the credits cover. */
export function creditedPackages(): Set<string> {
  return new Set(CREDITS.flatMap((c) => c.packages ?? []));
}
