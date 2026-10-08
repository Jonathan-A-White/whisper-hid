import { describe, expect, it } from "vitest";
import { frontEntry } from "./frontMessage";

interface Entry {
  id: string;
  text: string;
  timestamp: number;
  pinned: boolean;
}

// An in-memory stand-in for useTranscriptStore: one list, newest first, the
// same addEntry / updateEntry / deleteEntry the real store offers. Both the
// Talk screen and History read `entries`.
function fakeStore() {
  let entries: Entry[] = [];
  let n = 0;
  return {
    get entries() {
      return entries;
    },
    async addEntry(text: string): Promise<Entry> {
      const entry = { id: `id-${++n}`, text, timestamp: n, pinned: false };
      entries = [entry, ...entries];
      return entry;
    },
    async updateEntry(id: string, text: string) {
      entries = entries.map((e) => (e.id === id ? { ...e, text } : e));
    },
    async deleteEntry(id: string) {
      entries = entries.filter((e) => e.id !== id);
    },
  };
}

describe("frontEntry", () => {
  it("is the store's entry with that id", () => {
    const a = { id: "a", text: "one" };
    const b = { id: "b", text: "two" };
    expect(frontEntry([b, a], "a")).toBe(a);
  });
  it("is null with no id (nothing dictated yet)", () => {
    expect(frontEntry([{ id: "a", text: "one" }], null)).toBeNull();
  });
  it("is null when the entry is not in the store", () => {
    expect(frontEntry([{ id: "a", text: "one" }], "gone")).toBeNull();
  });
});

describe("front message and History share the store's entry", () => {
  it("after a dictation both show the same id and text", async () => {
    const store = fakeStore();
    const added = await store.addEntry("hello world");
    const front = frontEntry(store.entries, added.id);
    expect(front?.id).toBe(store.entries[0].id);
    expect(front?.text).toBe(store.entries[0].text);
  });

  it("updateEntry changes the text both render", async () => {
    const store = fakeStore();
    const added = await store.addEntry("hello world");
    await store.updateEntry(added.id, "hello, world.");
    const front = frontEntry(store.entries, added.id);
    expect(front?.text).toBe("hello, world.");
    expect(store.entries[0].text).toBe("hello, world.");
  });

  it("deleteEntry on the newest entry clears the front message, not showing the older one", async () => {
    const store = fakeStore();
    await store.addEntry("older");
    const newest = await store.addEntry("newest");
    await store.deleteEntry(newest.id);
    expect(frontEntry(store.entries, newest.id)).toBeNull();
    expect(store.entries.map((e) => e.text)).toEqual(["older"]);
  });
});
