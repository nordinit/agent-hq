import {
  normalizeHermesRuntimeConfig,
  validateHermesRuntimeConfig,
  type HermesRuntimeConfig,
} from "./config";

describe("Hermes runtime config", () => {
  const originalAllowlist = process.env.AGENT_HQ_ALLOWED_HERMES_BINARIES;

  afterEach(() => {
    if (originalAllowlist === undefined) delete process.env.AGENT_HQ_ALLOWED_HERMES_BINARIES;
    else process.env.AGENT_HQ_ALLOWED_HERMES_BINARIES = originalAllowlist;
  });

  it("only accepts the bare hermes command or an allowlisted absolute path", () => {
    delete process.env.AGENT_HQ_ALLOWED_HERMES_BINARIES;
    expect(validateHermesRuntimeConfig({ profile: "agent-hq-cinder" })).toBeNull();
    expect(validateHermesRuntimeConfig({ profile: "agent-hq-cinder", hermesBin: "hermes" })).toBeNull();
    for (const hermesBin of ["/bin/sh", "/usr/local/bin/hermes", "./hermes", "sh", 42]) {
      expect(validateHermesRuntimeConfig({ profile: "agent-hq-cinder", hermesBin } as HermesRuntimeConfig)).toMatch(/hermesBin/);
    }
    expect(() => normalizeHermesRuntimeConfig({ profile: "agent-hq-cinder", hermesBin: "/bin/sh" })).toThrow(/AGENT_HQ_ALLOWED_HERMES_BINARIES/);

    process.env.AGENT_HQ_ALLOWED_HERMES_BINARIES = "/usr/local/bin/hermes";
    expect(validateHermesRuntimeConfig({ profile: "agent-hq-cinder", hermesBin: "/usr/local/bin/hermes" })).toBeNull();
    expect(validateHermesRuntimeConfig({ profile: "agent-hq-cinder", hermesBin: "/bin/sh" })).toMatch(/not authorized/);
  });

  it("requires the profile to be a single path segment", () => {
    for (const profile of ["../../.ssh", "a/b", ".hidden", "with space"]) {
      expect(validateHermesRuntimeConfig({ profile })).toMatch(/runtime_config.profile must/);
    }
  });

  it("rejects missing or unsupported V1 config values", () => {
    expect(validateHermesRuntimeConfig({})).toBe(
      "runtime_config.profile is required for hermes runtime",
    );
    expect(
      validateHermesRuntimeConfig({
        profile: "agent-hq-cinder",
        ["lifecycle" + "Mode"]: "proxy",
      }),
    ).toContain("no longer supported");
    expect(
      validateHermesRuntimeConfig({
        profile: "agent-hq-cinder",
        sessionMode: "resume" as never,
      }),
    ).toBe('Hermes runtime only supports runtime_config.sessionMode="fresh" in V1');
    expect(
      validateHermesRuntimeConfig({
        profile: "agent-hq-cinder",
        invocationMode: "chat" as never,
      }),
    ).toBe(
      'Hermes runtime only supports runtime_config.invocationMode of "z" or "chat-q"',
    );
    expect(
      validateHermesRuntimeConfig({
        profile: "agent-hq-cinder",
        fastMode: "true" as never,
      }),
    ).toBe("runtime_config.fastMode must be a boolean when provided");
  });

  it.each([
    "--resume",
    "--continue",
    "--worktree",
    "--profile",
    "-p",
    "-z",
    "--resume=abc123",
    "--continue=abc123",
    "--worktree=/tmp/worktree",
    "--profile=agent-hq-cinder",
    "chat",
    "gateway",
    "acp",
    "sessions",
    "tools",
    "skills",
    "config",
    "model",
    "auth",
  ])("rejects Hermes-controlled extraArgs entry %s", (arg) => {
    expect(
      validateHermesRuntimeConfig({
        profile: "agent-hq-cinder",
        extraArgs: [arg],
      }),
    ).toBe(`Hermes runtime does not allow extraArgs entry ${JSON.stringify(arg)} in V1`);
  });

  it("validates extraArgs and environment value shapes", () => {
    expect(
      validateHermesRuntimeConfig({
        profile: "agent-hq-cinder",
        extraArgs: "--resume" as never,
      }),
    ).toBe("runtime_config.extraArgs must be an array of strings");
    expect(
      validateHermesRuntimeConfig({
        profile: "agent-hq-cinder",
        env: [] as never,
      }),
    ).toBe("runtime_config.env must be an object of string environment values");
    expect(
      validateHermesRuntimeConfig({
        profile: "agent-hq-cinder",
        env: { AGENT_HQ: true as never },
      }),
    ).toBe("runtime_config.env.AGENT_HQ must be a string");
  });

  it.each([
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "OPENAI_API_KEY",
    "PATH",
    "LD_PRELOAD",
    "AGENT_HQ_SESSION_KEY",
    "HERMES_HOME",
    "HERMES_FAST_MODE",
  ])("rejects protected or credential env key %s", (key) => {
    expect(
      validateHermesRuntimeConfig({
        profile: "agent-hq-cinder",
        env: { [key]: "value" },
      }),
    ).toBe(
      `runtime_config.env may not set protected or credential variable ${JSON.stringify(key)}`,
    );
  });

  it("allows Hermes tuning variables the adapter does not own", () => {
    expect(
      validateHermesRuntimeConfig({
        profile: "agent-hq-cinder",
        env: { HERMES_LOG_LEVEL: "debug" },
      }),
    ).toBeNull();
  });

  it("normalizes defaults and trimmed optional values without mutating inputs", () => {
    process.env.AGENT_HQ_ALLOWED_HERMES_BINARIES = "/usr/local/bin/hermes";
    const config: HermesRuntimeConfig = {
      hermesBin: " /usr/local/bin/hermes ",
      profile: " agent-hq-cinder ",
      hermesHome: " /tmp/hermes-home ",
      provider: " openai-codex ",
      model: " gpt-5.5 ",
      fastMode: false,
      workingDirectory: " /tmp/workspace ",
      ignoreUserConfig: true,
      ignoreRules: true,
      extraArgs: ["--debug"],
      env: { HQ_EXAMPLE_FLAG: "on" },
      heartbeatIntervalMs: 5,
      killGraceMs: 10,
    };

    const normalized = normalizeHermesRuntimeConfig(config);

    expect(normalized).toEqual({
      hermesBin: "/usr/local/bin/hermes",
      profile: "agent-hq-cinder",
      hermesHome: "/tmp/hermes-home",
      invocationMode: "z",
      sessionMode: "fresh",
      provider: "openai-codex",
      model: "gpt-5.5",
      fastMode: false,
      workingDirectory: "/tmp/workspace",
      ignoreUserConfig: true,
      ignoreRules: true,
      extraArgs: ["--debug"],
      env: { HQ_EXAMPLE_FLAG: "on" },
      heartbeatIntervalMs: 5,
      killGraceMs: 10,
    });
    expect(normalized.extraArgs).not.toBe(config.extraArgs);
    expect(normalized.env).not.toBe(config.env);
  });

  it("applies Hermes runtime defaults", () => {
    expect(normalizeHermesRuntimeConfig({ profile: "agent-hq-cinder" })).toEqual({
      hermesBin: "hermes",
      profile: "agent-hq-cinder",
      hermesHome: undefined,
      invocationMode: "z",
      sessionMode: "fresh",
      provider: null,
      model: null,
      fastMode: null,
      workingDirectory: undefined,
      ignoreUserConfig: false,
      ignoreRules: false,
      extraArgs: [],
      env: {},
      heartbeatIntervalMs: 60_000,
      killGraceMs: 10_000,
    });
  });

  it("throws validation errors while normalizing invalid config", () => {
    expect(() => normalizeHermesRuntimeConfig({ profile: " " })).toThrow(
      "runtime_config.profile is required for hermes runtime",
    );
  });
});
