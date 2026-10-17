import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isEnvFile, scanFiles, trackedFiles } from "./verify-no-secrets-in-repo.mjs";

/** Fake secrets, assembled at runtime so this file never holds one whole. */
const fake = {
  anthropic: `sk-ant-api03-${"A".repeat(93)}AA`,
  pem: ["-----BEGIN", "PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----"].join(" "),
  smtp: `smtps://me%40gmail.com:${"abcd".repeat(4)}@smtp.gmail.com`,
  github: `ghp_${"a".repeat(36)}`,
};

function scan(files) {
  return scanFiles(Object.keys(files), (path) => files[path]);
}

describe("scanFiles", () => {
  it("finds every kind of committed secret", () => {
    const findings = scan({
      "src/a.ts": `const key = "${fake.anthropic}";`,
      "scripts/key.pem": fake.pem,
      "docs/mail.md": `SMTP: ${fake.smtp}`,
      "notes.txt": fake.github,
    });
    expect(findings.map((finding) => finding.name).sort()).toEqual([
      "Anthropic API key",
      "GitHub personal/app token",
      "PEM private key",
      "a mail server URL with a password in it",
    ]);
  });

  it("refuses a committed .env file, but not the template or the functions' parameters", () => {
    expect(isEnvFile(".env")).toBe(true);
    expect(isEnvFile("functions/.env.local")).toBe(true);
    expect(isEnvFile(".env.example")).toBe(false);
    expect(isEnvFile("functions/.env.groove-35c07")).toBe(false);
    expect(scan({ ".env": "VITE_FIREBASE_API_KEY=x" })).toEqual([
      { file: ".env", name: "a committed .env file" },
    ]);
  });

  it("does not flag public config or the docs' placeholders", () => {
    expect(
      scan({
        "src/firebaseConfig.ts": 'apiKey: "AIzaSyD-FAKE_EXAMPLE_KEY_NOT_REAL_1234567"',
        "docs/runbook.md": "use `smtps://user:pass@smtp.gmail.com` or <app-password>",
        "src/scrub.test.ts": 'const leaked = "sk-ant-api03-abcdef";',
        ".env.example": "GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/key.json",
        "scripts/admin.mjs":
          'if (key.type === "service_account") use(key.private_key_id);',
      }),
    ).toEqual([]);
  });

  it("skips binary files", () => {
    expect(scan({ "public/a.wav": `RIFF\u0000${fake.github}` })).toEqual([]);
  });
});

describe("the repository", () => {
  it("has no secret in any tracked file", () => {
    const findings = scanFiles(trackedFiles(), (file) => readFileSync(file, "utf8"));
    expect(findings).toEqual([]);
  });
});
