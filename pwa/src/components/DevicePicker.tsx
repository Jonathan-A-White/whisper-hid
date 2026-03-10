import { useCallback, useEffect, useState } from "react";
import type { BtDevice } from "../types";
import { hidDevices, hidConnect } from "../lib/api";

interface DevicePickerProps {
  onClose: () => void;
  onConnected: () => void;
}

export function DevicePicker({ onClose, onConnected }: DevicePickerProps) {
  const [devices, setDevices] = useState<BtDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    hidDevices()
      .then((d) => setDevices(d.devices))
      .catch(() => setError("Failed to load devices"))
      .finally(() => setLoading(false));
  }, []);

  const handleConnect = useCallback(async (address: string) => {
    setConnecting(address);
    setError(null);
    try {
      await hidConnect(address);
      onConnected();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Connection failed");
    } finally {
      setConnecting(null);
    }
  }, [onConnected]);

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-end justify-center" onClick={onClose}>
      <div
        className="w-full max-w-md bg-gray-900 rounded-t-2xl p-4 pb-8"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-white font-semibold">Switch Bluetooth Device</h3>
          <button onClick={onClose} className="text-gray-400 text-sm px-2 py-1">
            Close
          </button>
        </div>

        {loading ? (
          <p className="text-gray-400 text-sm py-4 text-center">Loading devices...</p>
        ) : devices.length === 0 ? (
          <p className="text-gray-400 text-sm py-4 text-center">No bonded devices found</p>
        ) : (
          <div className="space-y-2">
            {devices.map((device) => {
              const isCurrent = device.connected;
              const isConnecting = connecting === device.address;
              return (
                <button
                  key={device.address}
                  onClick={() => !isCurrent && handleConnect(device.address)}
                  disabled={isCurrent || connecting !== null}
                  className={`w-full text-left px-4 py-3 rounded-lg flex items-center justify-between ${
                    isCurrent
                      ? "bg-sky-900/40 border border-sky-700"
                      : "bg-gray-800 hover:bg-gray-700"
                  } disabled:opacity-50`}
                >
                  <div>
                    <p className={`text-sm ${isCurrent ? "text-sky-300" : "text-white"}`}>
                      {device.name}
                    </p>
                    <p className="text-xs text-gray-500">{device.address}</p>
                  </div>
                  {isCurrent && (
                    <span className="text-xs text-sky-400">Connected</span>
                  )}
                  {isConnecting && (
                    <span className="text-xs text-yellow-400">Connecting...</span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {error && (
          <p className="text-red-400 text-xs mt-3 text-center">{error}</p>
        )}
      </div>
    </div>
  );
}
