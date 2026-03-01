import { useState } from "react";
import type { ModelInfo, BenchmarkResult } from "../types";
import { benchmarkModels } from "../lib/api";

interface ModelBenchmarkProps {
  models: ModelInfo[];
}

export function ModelBenchmark({ models }: ModelBenchmarkProps) {
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState<string>("");
  const [results, setResults] = useState<BenchmarkResult[] | null>(null);
  const [audioDuration, setAudioDuration] = useState<number>(0);
  const [vadAvailable, setVadAvailable] = useState(false);
  const [useVad, setUseVad] = useState(false);
  const [duration, setDuration] = useState(3);
  const [error, setError] = useState<string | null>(null);
  const [selectedModels, setSelectedModels] = useState<Set<string>>(new Set());

  const downloaded = models.filter((m) => m.downloaded);

  const toggleModel = (name: string) => {
    setSelectedModels((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const runBenchmark = async () => {
    setError(null);
    setResults(null);
    setRunning(true);

    const targetModels =
      selectedModels.size > 0 ? Array.from(selectedModels) : undefined;
    const count = targetModels?.length ?? downloaded.length;
    setPhase(`Recording ${duration}s of audio...`);

    try {
      const data = await benchmarkModels({
        models: targetModels,
        duration,
        use_vad: useVad,
      });
      setResults(data.results);
      setAudioDuration(data.audio_duration_sec);
      setVadAvailable(data.vad_available);
      setPhase(`Done — tested ${count} model${count > 1 ? "s" : ""}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Benchmark failed");
      setPhase("");
    } finally {
      setRunning(false);
    }
  };

  // Find best result for highlighting
  const fastest = results
    ? results.reduce<BenchmarkResult | null>(
        (best, r) =>
          r.error
            ? best
            : !best || r.inference_ms < best.inference_ms
              ? r
              : best,
        null
      )
    : null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-gray-300">
          Model Benchmark
        </h3>
        {vadAvailable && (
          <label className="flex items-center gap-1.5 text-xs text-gray-400">
            <input
              type="checkbox"
              checked={useVad}
              onChange={(e) => setUseVad(e.target.checked)}
              disabled={running}
              className="w-3.5 h-3.5 accent-sky-500"
            />
            VAD
          </label>
        )}
      </div>

      {/* Model selection chips */}
      {downloaded.length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          {downloaded.map((m) => {
            const selected =
              selectedModels.size === 0 || selectedModels.has(m.name);
            return (
              <button
                key={m.name}
                onClick={() => toggleModel(m.name)}
                disabled={running}
                className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                  selected
                    ? "border-sky-500 text-sky-400 bg-sky-500/10"
                    : "border-gray-700 text-gray-500 bg-transparent"
                } disabled:opacity-50`}
              >
                {m.name}
              </button>
            );
          })}
          {selectedModels.size > 0 && (
            <button
              onClick={() => setSelectedModels(new Set())}
              disabled={running}
              className="text-xs px-2 py-1 text-gray-500 hover:text-gray-300"
            >
              All
            </button>
          )}
        </div>
      )}

      {/* Duration slider */}
      <div>
        <label className="text-xs text-gray-500 block mb-1">
          Record {duration}s of speech for the test
        </label>
        <input
          type="range"
          min={2}
          max={10}
          value={duration}
          onChange={(e) => setDuration(parseInt(e.target.value))}
          disabled={running}
          className="w-full accent-sky-500"
        />
      </div>

      {/* Run button */}
      <button
        onClick={runBenchmark}
        disabled={running || downloaded.length === 0}
        className="w-full py-2.5 rounded bg-sky-600 text-white text-sm font-medium disabled:opacity-40 active:bg-sky-700"
      >
        {running ? phase : "Run Benchmark"}
      </button>

      {error && <p className="text-xs text-red-400">{error}</p>}

      {/* Results */}
      {results && results.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs text-gray-500">
            Audio: {audioDuration}s
            {useVad ? " (VAD enabled)" : ""}
          </p>

          {results.map((r) => (
            <div
              key={r.model}
              className={`rounded-lg border p-3 space-y-1.5 ${
                fastest && r.model === fastest.model
                  ? "border-sky-500/50 bg-sky-500/5"
                  : "border-gray-800 bg-gray-900/50"
              }`}
            >
              {/* Header row */}
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-white">
                  {r.model}
                </span>
                <span className="text-xs text-gray-500">{r.size_mb} MB</span>
              </div>

              {r.error ? (
                <p className="text-xs text-red-400">{r.error}</p>
              ) : (
                <>
                  {/* Stats row */}
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-gray-400">
                      {(r.inference_ms / 1000).toFixed(1)}s
                    </span>
                    <span
                      className={`text-xs font-medium ${
                        r.speed_ratio >= 3
                          ? "text-green-400"
                          : r.speed_ratio >= 1
                            ? "text-yellow-400"
                            : "text-red-400"
                      }`}
                    >
                      {r.speed_ratio}x real-time
                    </span>
                    {fastest && r.model === fastest.model && (
                      <span className="text-xs text-sky-400">fastest</span>
                    )}
                  </div>

                  {/* Speed bar */}
                  <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full ${
                        r.speed_ratio >= 3
                          ? "bg-green-500"
                          : r.speed_ratio >= 1
                            ? "bg-yellow-500"
                            : "bg-red-500"
                      }`}
                      style={{
                        width: `${Math.min(100, (r.speed_ratio / (fastest?.speed_ratio || 1)) * 100)}%`,
                      }}
                    />
                  </div>

                  {/* Transcription text */}
                  <p className="text-xs text-gray-400 leading-relaxed break-words">
                    {r.text || (
                      <span className="italic text-gray-600">
                        No speech detected
                      </span>
                    )}
                  </p>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {downloaded.length === 0 && (
        <p className="text-xs text-gray-500">
          No models downloaded. Download at least one model to benchmark.
        </p>
      )}
    </div>
  );
}
