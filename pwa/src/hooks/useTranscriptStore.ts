import { useCallback, useEffect, useState } from "react";
import type { TranscriptEntry } from "../types";

const DB_NAME = "whisper-keyboard";
const STORE_NAME = "transcripts";
const DB_VERSION = 1;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex("timestamp", "timestamp", { unique: false });
        store.createIndex("pinned", "pinned", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function useTranscriptStore() {
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [searchQuery, setSearchQuery] = useState("");

  const loadEntries = useCallback(async () => {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const request = store.getAll();
    return new Promise<TranscriptEntry[]>((resolve) => {
      request.onsuccess = () => {
        const all = request.result as TranscriptEntry[];
        // Sort: pinned first, then by timestamp descending
        all.sort((a, b) => {
          if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
          return b.timestamp - a.timestamp;
        });
        resolve(all);
      };
    });
  }, []);

  const refresh = useCallback(async () => {
    const all = await loadEntries();
    setEntries(all);
  }, [loadEntries]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const addEntry = useCallback(
    async (text: string) => {
      if (!text.trim()) return;
      const entry: TranscriptEntry = {
        id: crypto.randomUUID(),
        text: text.trim(),
        timestamp: Date.now(),
        pinned: false,
      };
      const db = await openDB();
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).add(entry);
      await new Promise<void>((resolve) => {
        tx.oncomplete = () => resolve();
      });
      await refresh();
      return entry;
    },
    [refresh]
  );

  const deleteEntry = useCallback(
    async (id: string) => {
      const db = await openDB();
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).delete(id);
      await new Promise<void>((resolve) => {
        tx.oncomplete = () => resolve();
      });
      await refresh();
    },
    [refresh]
  );

  const togglePin = useCallback(
    async (id: string) => {
      const db = await openDB();
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(id);
      request.onsuccess = () => {
        const entry = request.result as TranscriptEntry;
        entry.pinned = !entry.pinned;
        store.put(entry);
      };
      await new Promise<void>((resolve) => {
        tx.oncomplete = () => resolve();
      });
      await refresh();
    },
    [refresh]
  );

  const clearAll = useCallback(async () => {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).clear();
    await new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve();
    });
    await refresh();
  }, [refresh]);

  const filteredEntries = searchQuery
    ? entries.filter((e) =>
        e.text.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : entries;

  const pinnedEntries = entries.filter((e) => e.pinned);

  return {
    entries: filteredEntries,
    pinnedEntries,
    searchQuery,
    setSearchQuery,
    addEntry,
    deleteEntry,
    togglePin,
    clearAll,
    refresh,
  };
}
