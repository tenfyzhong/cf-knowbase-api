import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  new URL("../.github/workflows/deploy.yml", import.meta.url),
  "utf8"
);
const names = ["ACCESS_TEAM_DOMAIN", "ACCESS_AUD", "ACCESS_EMAIL_DOMAIN"];
const configured = {
  ACCESS_TEAM_DOMAIN: "test-team.cloudflareaccess.com",
  ACCESS_AUD: "test-application-audience",
  ACCESS_EMAIL_DOMAIN: "example.org"
};

function validate(env: Record<string, string>) {
  const body = workflow.match(
    /      - name: Validate Access deployment configuration\n        run: \|\n((?:          .*\n)+)/
  )?.[1];
  expect(
    body,
    "deployment must validate configuration before publishing"
  ).toBeTruthy();
  return spawnSync(
    "bash",
    ["--noprofile", "--norc", "-c", body!.replace(/^          /gm, "")],
    {
      env,
      encoding: "utf8"
    }
  );
}

describe("GitHub Actions Access deployment", () => {
  it("accepts a fully configured deployment without printing values", () => {
    const result = validate(configured);
    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).toBe("");
  });

  it.each(names)("rejects missing %s before deployment", (name) => {
    const env: Record<string, string> = { ...configured };
    delete env[name];
    const result = validate(env);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain(name);
    for (const value of Object.values(env)) {
      expect(result.stdout + result.stderr).not.toContain(value);
    }
  });

  it.each(names)("rejects blank %s before deployment", (name) => {
    expect(validate({ ...configured, [name]: " \t " }).status).toBe(1);
  });

  it("treats configuration as data without evaluating shell expressions", () => {
    const result = validate({
      ...configured,
      ACCESS_AUD: "$(printf unexpected-command-output)"
    });
    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).toBe("");
  });

  it("reads Secrets or Variables as environment data and binds Worker secrets", () => {
    const deployment = workflow.split("      - name: Deploy Worker\n")[1];
    expect(deployment).toBeTruthy();
    const secrets = deployment.match(
      /          secrets: \|\n((?:            .*\n)+)/
    )?.[1];
    for (const name of names) {
      expect(workflow).toContain(
        `${name}: \${{ secrets.${name} || vars.${name} }}`
      );
      expect(secrets).toContain(name);
    }
    const validationIndex = workflow.indexOf(
      "- name: Validate Access deployment configuration"
    );
    expect(validationIndex).toBeGreaterThan(0);
    expect(validationIndex).toBeLessThan(
      workflow.indexOf("- name: Deploy Worker")
    );
    // Values must not be interpolated into executable shell/CLI text.
    expect(deployment).not.toMatch(/command:.*(?:secrets|vars)\.ACCESS_/);
    const config = readFileSync(
      new URL("../wrangler.toml", import.meta.url),
      "utf8"
    );
    for (const name of names) {
      expect(config).not.toMatch(new RegExp(`^${name}\\s*=`, "m"));
    }
  });
});
