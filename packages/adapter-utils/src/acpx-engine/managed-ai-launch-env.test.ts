// A managed AI connection neutralizes the provider auth and routing keys by
// writing each as an empty string. These tests pin where that empty assignment
// becomes an absent key and where it must survive: a host-side launch env is
// the child's own, so absence is the complete answer there, while a remote
// sandbox launch env is merged onto a shell this process does not own.

import { describe, expect, it } from "vitest";
import { MANAGED_AI_NEUTRALIZED_ENV_KEYS } from "@paperclipai/shared";
import { finalizeLaunchEnvironment } from "./execute.js";

const NEUTRALIZED_MANAGED_AI_ENV = Object.fromEntries(
  MANAGED_AI_NEUTRALIZED_ENV_KEYS.map((key) => [key, ""]),
) as Record<string, string>;

describe("managed AI neutralization in the ACPX launch environment", () => {
  it("launches a host-side child with no empty provider routing value", () => {
    const launched = finalizeLaunchEnvironment(
      { ...NEUTRALIZED_MANAGED_AI_ENV },
      [],
      {
        acpxAgent: "claude",
        inheritHostEnvironment: true,
        materializesChildEnvironment: true,
        inheritedEnv: { PATH: "/usr/bin" },
      },
    );
    // The empty string is what broke every descendant that imports a provider
    // SDK at module load, so no neutralized key may reach the child empty.
    const empty = MANAGED_AI_NEUTRALIZED_ENV_KEYS.filter(
      (key) => launched.env[key] === "",
    );
    expect(empty).toEqual([]);
  });

  it("keeps the host's own routing value out of a host-side child", () => {
    // Absence is only acceptable because the key is dropped after the host
    // projection was overlaid, so the host value goes with it.
    const launched = finalizeLaunchEnvironment(
      { ANTHROPIC_BASE_URL: "", ANTHROPIC_API_KEY: "" },
      [],
      {
        acpxAgent: "claude",
        inheritHostEnvironment: true,
        materializesChildEnvironment: true,
        inheritedEnv: {
          ANTHROPIC_BASE_URL: "https://host-proxy.example",
          ANTHROPIC_API_KEY: "host-key",
          PATH: "/usr/bin",
        },
      },
    );
    expect("ANTHROPIC_BASE_URL" in launched.env).toBe(false);
    expect("ANTHROPIC_API_KEY" in launched.env).toBe(false);
  });

  it("keeps the empty assignment for a remote sandbox launch", () => {
    // This env crosses a serialization boundary and is applied onto a shell we
    // do not own. Dropping the key there would re-admit the sandbox's value.
    const launched = finalizeLaunchEnvironment(
      { ANTHROPIC_BASE_URL: "", OPENAI_BASE_URL: "" },
      [],
      { acpxAgent: "claude", inheritHostEnvironment: false, inheritedEnv: {} },
    );
    expect(launched.env.ANTHROPIC_BASE_URL).toBe("");
    expect(launched.env.OPENAI_BASE_URL).toBe("");
  });

  it("keeps the empty assignment for a launch that ships this env elsewhere", () => {
    // An SSH target still projects the host env, but the launch applies it onto
    // a shell on the far side. The conservative default covers that lane.
    const launched = finalizeLaunchEnvironment(
      { ANTHROPIC_BASE_URL: "" },
      [],
      {
        acpxAgent: "claude",
        inheritHostEnvironment: true,
        inheritedEnv: { PATH: "/usr/bin" },
      },
    );
    expect(launched.env.ANTHROPIC_BASE_URL).toBe("");
  });

  it("keeps the values a managed runtime actually selected", () => {
    const launched = finalizeLaunchEnvironment(
      {
        ...NEUTRALIZED_MANAGED_AI_ENV,
        CLAUDE_CONFIG_DIR: "/tmp/managed/provider",
        ANTHROPIC_AUTH_TOKEN: "selected-token",
      },
      [],
      {
        acpxAgent: "claude",
        inheritHostEnvironment: true,
        materializesChildEnvironment: true,
        inheritedEnv: { PATH: "/usr/bin" },
      },
    );
    expect(launched.env.CLAUDE_CONFIG_DIR).toBe("/tmp/managed/provider");
    expect(launched.env.ANTHROPIC_AUTH_TOKEN).toBe("selected-token");
    expect(launched.env.PATH).toBe("/usr/bin");
  });

  it("leaves an unrelated empty value in place", () => {
    const launched = finalizeLaunchEnvironment(
      { SOME_PROJECT_FLAG: "" },
      [],
      {
        acpxAgent: "claude",
        inheritHostEnvironment: true,
        materializesChildEnvironment: true,
        inheritedEnv: { PATH: "/usr/bin" },
      },
    );
    expect(launched.env.SOME_PROJECT_FLAG).toBe("");
  });
});
