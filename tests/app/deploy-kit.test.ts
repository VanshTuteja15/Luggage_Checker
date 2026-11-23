/* ------------------------------------------------------------------ */
/*  Oracle deploy kit (v4 A8, DEPLOY-1/2): the rules that hold without  */
/*  Docker or a cloud account. `docker compose config` and the script   */
/*  dry runs are run by hand (docs/DEPLOY_ORACLE.md, last section).     */
/* ------------------------------------------------------------------ */

import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const DIR = "deploy/oracle";
const read = (f: string) => readFileSync(`${DIR}/${f}`, "utf8");

/** The `ports:` lines of one compose service (the file is ours, so a plain reader will do). */
function portsOf(compose: string, service: string): string[] {
  const block = compose.split(/\n(?= {2}[a-z]+:\n)/).find((b) => b.startsWith(`  ${service}:`));
  if (!block) throw new Error(`no service ${service}`);
  const m = block.match(/\n {4}ports:\n((?: {6}- .*\n)+)/);
  return m
    ? m[1]
        .trim()
        .split("\n")
        .map((l) => l.replace(/^\s*- /, "").replace(/"/g, ""))
    : [];
}

describe("compose.yml (DEPLOY-2)", () => {
  const compose = read("compose.yml");

  it("publishes the worker and Ollama on 127.0.0.1 only, and Postgres nowhere", () => {
    expect(portsOf(compose, "worker")).toEqual(["127.0.0.1:8787:8787"]);
    expect(portsOf(compose, "ollama")).toEqual(["127.0.0.1:11434:11434"]);
    expect(portsOf(compose, "db")).toEqual([]);
    expect(compose).not.toMatch(/^\s*- "?(0\.0\.0\.0:)?\d+:\d+"?\s*$/m);
  });

  it("keeps one small model loaded, one request at a time; optional services sit behind profiles", () => {
    expect(compose).toMatch(/OLLAMA_KEEP_ALIVE: "-1"/);
    expect(compose).toMatch(/OLLAMA_NUM_PARALLEL: "1"/);
    expect(compose).toMatch(/OLLAMA_MODEL: \$\{OLLAMA_MODEL:-qwen2\.5:3b\}/);
    expect(compose).toMatch(/ {2}db:\n {4}profiles: \["localdb"\]/);
    expect(compose).toMatch(/ {2}tunnel:\n {4}profiles: \["tunnel"\]/);
    // The worker may reach Ollama only by its compose name (the client's URL guard).
    expect(compose).toMatch(/OLLAMA_ALLOWED_HOSTS: ollama/);
  });
});

describe("scripts (DEPLOY-1)", () => {
  it("setup.sh has a dry run and refuses root without --yes", () => {
    const setup = read("setup.sh");
    expect(setup.startsWith("#!/usr/bin/env bash")).toBe(true);
    expect(setup).toMatch(/set -euo pipefail/);
    expect(setup).toMatch(/--check\) MODE="check"/);
    expect(setup).toMatch(/if \[ "\$\(id -u\)" -eq 0 \] && \[ "\$MODE" != "install" \]; then/);
    expect(setup).toMatch(/Refusing to run as root without --yes/);
    // The dry run exits before the first change.
    expect(setup.indexOf('if [ "$MODE" = "check" ]; then')).toBeLessThan(
      setup.indexOf("apt-get update"),
    );
  });

  it("backup.sh keeps the connection string off the command line and prunes only its own dumps", () => {
    const backup = read("backup.sh");
    expect(backup).toMatch(/--env DATABASE_URL postgres:17-alpine/);
    expect(backup).not.toMatch(/echo .*\$DB_URL/);
    expect(backup).toMatch(/-name 'luggagetracker-\*\.sql\.gz'/);
    expect(backup).toMatch(/--dry-run/);
  });
});

describe("no secrets in the kit (DEPLOY-1)", () => {
  it("env.example names variables but holds no secret values", () => {
    const lines = read("env.example")
      .split("\n")
      .filter((l) => /^[A-Z_]+=/.test(l));
    const filled = lines.filter((l) => !/=$/.test(l)).map((l) => l.split("=")[0]);
    expect(filled.sort()).toEqual(["AI_LANES", "OLLAMA_MODEL"]);
  });

  it("no file holds a key, token, password or connection string", () => {
    for (const f of readdirSync(DIR)) {
      const text = read(f);
      expect(text, f).not.toMatch(/postgres(?:ql)?:\/\/[^\s"'<]*:[^\s"'<@]+@/i);
      expect(text, f).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/);
      expect(text, f).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
      expect(text, f).not.toMatch(/\b(?:sk|rk|re)_[A-Za-z0-9]{20,}/);
    }
  });
});
