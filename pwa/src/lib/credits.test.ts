import { describe, expect, it } from "vitest";
import packageJson from "../../package.json?raw";
import buildGradle from "../../../app/build.gradle.kts?raw";
import requirements from "../../../scripts/requirements.txt?raw";
import readme from "../../../README.md?raw";
import aboutSource from "../components/AboutView.tsx?raw";
import settingsSource from "../components/SettingsView.tsx?raw";
import { CREDITS, NEWTON_QUOTE, WHY_WE_CREDIT, creditedPackages } from "./credits";
import type { Credit } from "./credits";
import { staleCreditedPackages, uncreditedFiles } from "./creditsCheck";

// Bundled font and data files, repo-relative. The app ships none today; a
// file dropped into one of these places must be credited in the same commit.
const shippedFiles = Object.keys({
  ...import.meta.glob("../../public/**/*", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../app/src/main/assets/**/*", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../app/src/main/res/font/**/*", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../app/src/main/res/raw/**/*", { query: "?url", import: "default" }),
}).map((f) => f.replace(/^(\.\.\/)+/, "").replace(/^(?=public\/)/, "pwa/"));

// "A test fails when a runtime dependency is missing from the credits, so
// adding a library means crediting it in the same commit." The repo has three
// dependency lists; this reads each one and checks every entry is named in
// CREDITS (packages: "npm:react", "gradle:group:artifact", "pip:flask").

function npmDependencies(): string[] {
  const pkg = JSON.parse(packageJson);
  return [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ].map((name) => `npm:${name}`);
}

function gradleDependencies(): string[] {
  const found: string[] = [];
  for (const m of buildGradle.matchAll(
    /\b(?:implementation|api|testImplementation|kapt|ksp)\(\s*"([^":]+):([^":]+):[^"]*"/g
  )) {
    found.push(`gradle:${m[1]}:${m[2]}`);
  }
  return found;
}

function pipRequirements(): string[] {
  return requirements
    .split("\n")
    .map((line: string) => line.replace(/#.*/, "").trim())
    .filter(Boolean)
    .map((line) => `pip:${line.split(/[<>=!~;[ ]/)[0].toLowerCase()}`);
}

const credited = creditedPackages();

describe("every dependency is credited", () => {
  it("finds the dependency lists it is meant to read", () => {
    expect(npmDependencies()).toContain("npm:react");
    expect(gradleDependencies()).toContain("gradle:androidx.core:core-ktx");
    expect(pipRequirements()).toContain("pip:flask");
  });

  it.each([
    ["npm (pwa/package.json)", npmDependencies],
    ["Gradle (app/build.gradle.kts)", gradleDependencies],
    ["pip (scripts/requirements.txt)", pipRequirements],
  ])("credits every %s dependency", (_label, list) => {
    const missing = list().filter((id) => !credited.has(id));
    expect(missing, `add these to CREDITS in src/lib/credits.ts: ${missing}`).toEqual([]);
  });

  it("credits packages that are installed outside the lists", () => {
    for (const id of ["pip:numpy", "pip:onnxruntime", "pip:sherpa-onnx"]) {
      expect(credited.has(id), id).toBe(true);
    }
  });
});

// Dependencies installed by the phone's package manager, not by a list file.
const OUTSIDE_THE_LISTS = ["pip:numpy", "pip:onnxruntime", "pip:sherpa-onnx"];

const fake = (over: Partial<Credit>): Credit => ({
  name: "X",
  kind: "pwa",
  url: "https://x.example",
  use: "u",
  license: "MIT",
  licenseUrl: "https://x.example/license",
  changes: "None.",
  ...over,
});

describe("credits follow removals", () => {
  it("names no package that is not a dependency", () => {
    const all = [...npmDependencies(), ...gradleDependencies(), ...pipRequirements()];
    const stale = staleCreditedPackages(CREDITS, all, OUTSIDE_THE_LISTS);
    expect(stale, `remove these from CREDITS in src/lib/credits.ts: ${stale}`).toEqual([]);
  });

  it("fails on a credit for a package removed from the list", () => {
    const credits = [
      fake({ name: "React", packages: ["npm:react"] }),
      fake({ name: "Gone", packages: ["npm:left-pad"] }),
    ];
    expect(staleCreditedPackages(credits, ["npm:react"])).toEqual(["npm:left-pad"]);
    expect(staleCreditedPackages(credits, ["npm:react", "npm:left-pad"])).toEqual([]);
  });

  it("lets a package installed outside the lists stay credited", () => {
    const credits = [fake({ packages: ["pip:numpy"] })];
    expect(staleCreditedPackages(credits, [])).toEqual(["pip:numpy"]);
    expect(staleCreditedPackages(credits, [], ["pip:numpy"])).toEqual([]);
  });

  it("leaves credits that are not packages alone, by kind", () => {
    const credits = [
      fake({ name: "An idea", kind: "idea" }),
      fake({ name: "A model", kind: "model" }),
      fake({ name: "A service", kind: "service" }),
      fake({ name: "A font", kind: "tool", files: ["pwa/public/fonts/a.woff2"] }),
    ];
    expect(staleCreditedPackages(credits, [])).toEqual([]);
    // and the real list has such credits, so the exemption is exercised on main
    expect(CREDITS.some((c) => c.kind === "idea" && !c.packages)).toBe(true);
    expect(CREDITS.some((c) => c.kind === "service" && !c.packages)).toBe(true);
  });
});

describe("bundled fonts and data files are credited", () => {
  it("credits every font and data file the app ships", () => {
    const missing = uncreditedFiles(CREDITS, shippedFiles);
    expect(missing, `name these in a CREDITS entry's files: ${missing}`).toEqual([]);
  });

  it("fails on a shipped file no credit names", () => {
    const credits = [
      fake({ files: ["pwa/public/fonts/a.woff2", "pwa/public/data/"] }),
    ];
    expect(uncreditedFiles(credits, ["pwa/public/fonts/a.woff2"])).toEqual([]);
    expect(uncreditedFiles(credits, ["pwa/public/data/words.json"])).toEqual([]);
    expect(uncreditedFiles(credits, ["pwa/public/fonts/b.woff2", "pwa/public/datum.json"])).toEqual([
      "pwa/public/fonts/b.woff2",
      "pwa/public/datum.json",
    ]);
  });
});

describe("each credit is complete", () => {
  it("has a name, https links, a use, a licence and a changes line", () => {
    for (const c of CREDITS) {
      expect(c.name.trim(), "name").not.toBe("");
      expect(c.url, `${c.name} url`).toMatch(/^https:\/\//);
      expect(c.license.trim(), `${c.name} license`).not.toBe("");
      expect(c.licenseUrl, `${c.name} licenseUrl`).toMatch(/^https:\/\//);
      expect(c.use.trim(), `${c.name} use`).not.toBe("");
      expect(c.changes.trim(), `${c.name} changes`).not.toBe("");
    }
  });

  it("has no duplicate names", () => {
    const names = CREDITS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("credits the speech models, the borrowed ideas and the services", () => {
    const names = CREDITS.map((c) => c.name).join("|");
    for (const needle of [
      "Parakeet",
      "Whisper",
      "Qwen3",
      "llama.cpp",
      "Beads",
      "Gas Town",
      "Claude Code",
      "GitHub",
      "Hugging Face",
    ]) {
      expect(names, needle).toContain(needle);
    }
  });
});

describe("the About screen", () => {
  it("quotes Newton with his attribution, then says why we credit", () => {
    expect(NEWTON_QUOTE.text).toBe("If I have seen further it is by standing on the shoulders of Giants.");
    expect(NEWTON_QUOTE.by).toMatch(/Isaac Newton/);
    expect(NEWTON_QUOTE.by).toMatch(/Robert Hooke/);
    expect(NEWTON_QUOTE.by).toMatch(/1675/);
    expect(WHY_WE_CREDIT.split(/[.!?]\s/).filter(Boolean)).toHaveLength(1);
  });

  it("puts the quote, then the reason, then the list, and links by name", () => {
    const lines = aboutSource.split("\n");
    const at = (needle: string) => lines.findIndex((l) => l.includes(needle));
    expect(at("{NEWTON_QUOTE.text}")).toBeGreaterThan(-1);
    expect(at("{NEWTON_QUOTE.text}")).toBeLessThan(at("{WHY_WE_CREDIT}"));
    expect(at("{WHY_WE_CREDIT}")).toBeGreaterThan(-1);
    expect(at("{WHY_WE_CREDIT}")).toBeLessThan(at("CREDITS.filter"));
    // the link text is the name, never the raw URL
    expect(aboutSource).toMatch(/\{c\.name\}/);
    expect(aboutSource).not.toMatch(/>\s*\{c\.url\}/);
    expect(aboutSource).toMatch(/c\.licenseUrl/);
  });

  it("is reached from the About section of Settings", () => {
    expect(settingsSource).toContain("onShowAbout");
  });
});

describe("the README credits", () => {
  const section = readme.split(/^## Credits\s*$/m)[1]?.split(/^## /m)[0] ?? "";

  it("has a Credits section with Newton's line", () => {
    expect(section).not.toBe("");
    expect(section).toContain(NEWTON_QUOTE.text);
  });

  it("lists every credit by name with its link and licence link", () => {
    for (const c of CREDITS) {
      expect(section, c.name).toContain(`[${c.name}](${c.url})`);
      expect(section, `${c.name} licence`).toContain(`](${c.licenseUrl})`);
    }
  });
});
