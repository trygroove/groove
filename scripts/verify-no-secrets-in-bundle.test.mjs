import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanForSecrets } from "./verify-no-secrets-in-bundle.mjs";

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "verify-no-secrets-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(relativePath, content) {
  const full = join(dir, relativePath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, "utf8");
}

describe("scanForSecrets", () => {
  it("finds nothing in an ordinary built bundle", () => {
    write("index.html", "<!doctype html><html><body>Groove</body></html>");
    write("assets/client.js", 'console.log("hello"); export const x = 1 + 2;');
    write("assets/client.css", "body { color: red; }");

    expect(scanForSecrets(dir)).toEqual([]);
  });

  it("does not flag Firebase's public-by-design client config values", () => {
    // A real Firebase Web API key is not a secret -- it identifies the
    // project, and access is enforced server-side by security rules. It
    // must never trip this scanner, or every real build would fail.
    write(
      "assets/firebaseConfig.js",
      'var firebaseConfig = { apiKey: "AIzaSyD-FAKE_EXAMPLE_KEY_NOT_REAL_1234567", authDomain: "demo.firebaseapp.com", projectId: "demo-solid-groove", appId: "1:1234567890:web:abcdef0123456789" };',
    );

    expect(scanForSecrets(dir)).toEqual([]);
  });

  it("flags a PEM private key", () => {
    write(
      "assets/leak.js",
      'const k = "-----BEGIN PRIVATE KEY-----\\nMIIExample\\n-----END PRIVATE KEY-----";',
    );

    const findings = scanForSecrets(dir);
    expect(findings).toHaveLength(1);
    expect(findings[0].name).toBe("PEM private key");
  });

  it("flags an embedded service account JSON", () => {
    write(
      "assets/leak.js",
      JSON.stringify({
        type: "service_account",
        project_id: "demo-solid-groove",
        private_key_id: "abc123",
      }),
    );

    const findings = scanForSecrets(dir);
    const names = findings.map((f) => f.name);
    expect(names).toContain("service account JSON (type: service_account)");
    expect(names).toContain("service account JSON (private_key_id field)");
  });

  it("flags an AWS access key ID", () => {
    write("assets/leak.js", 'const id = "AKIAABCDEFGHIJKLMNOP";');

    const findings = scanForSecrets(dir);
    expect(findings.map((f) => f.name)).toContain("AWS access key ID");
  });

  it("flags a GitHub token", () => {
    write("assets/leak.js", `const t = "ghp_${"a".repeat(36)}";`);

    const findings = scanForSecrets(dir);
    expect(findings.map((f) => f.name)).toContain("GitHub personal/app token");
  });

  it("flags a PostHog personal API key, but not the public project key", () => {
    write("assets/leak.js", `const k = "phx_${"a".repeat(40)}";`);
    write("assets/ok.js", `const k = "phc_${"a".repeat(40)}";`);

    const findings = scanForSecrets(dir);
    expect(findings.map((f) => f.name)).toEqual(["PostHog personal API key"]);
  });

  it("flags a raw .env-style assignment of a known server secret", () => {
    write(
      "assets/leak.txt",
      'FIREBASE_DEPLOY_SERVICE_ACCOUNT={"type":"service_account"}',
    );

    const findings = scanForSecrets(dir);
    expect(findings.map((f) => f.name)).toContain(
      "a raw .env-style assignment of a known server-only secret",
    );
  });

  it("ignores compressed .br/.gz siblings rather than scanning binary bytes", () => {
    // A real .gz/.br file is binary; writing text here is enough to prove
    // the extension is skipped regardless of content.
    write("assets/leak.js.gz", "-----BEGIN PRIVATE KEY-----");

    expect(scanForSecrets(dir)).toEqual([]);
  });

  it("recurses into nested directories", () => {
    write("nested/deep/leak.js", "AKIAABCDEFGHIJKLMNOP");

    expect(scanForSecrets(dir)).toHaveLength(1);
  });
});
