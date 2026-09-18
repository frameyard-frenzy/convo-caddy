import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderSetupGuide } from "../../src/desktop/setup-guide.js";
import {
  runShell,
  shellAvailable,
  shellRequired,
} from "../fixtures/shell-runtime.js";

const human = readFileSync("docs/hermes-connection-setup.md", "utf8");
const agent = readFileSync("docs/hermes-owner-handoff.md", "utf8");
const blocks = (text: string) =>
  [...text.matchAll(/```(?:bash|command)\n([\s\S]*?)\n```/g)].map(
    (m) => m[1] ?? "",
  );
const all = [...blocks(human), ...blocks(agent)];
const consumers = all.filter((b) => /\/usr\/bin\/ssh |--ssh /.test(b));
const assignment =
  blocks(human).find((b) => /^\s*HERMES_SSH_TARGET=/m.test(b)) ?? "";
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const guard =
  '"${HERMES_SSH_TARGET:?Complete step 2 in this local Terminal tab}"';

it("uses Moritz's exact linked Tailscale requirement and preserves screenshot edits", () => {
  const readme = readFileSync("README.md", "utf8");
  const requirement =
    readme
      .split("\n")
      .find((line) => line.startsWith("- Only for two Macs:")) ?? "";
  expect(requirement.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")).toBe(
    "- Only for two Macs: Tailscale installed and connected on both Macs, using the same Tailscale account. The Macs can be in different locations and on different Wi-Fi networks.",
  );
  expect(requirement).toContain(
    "](docs/hermes-connection-setup.md#1-prepare-before-leaving-the-hermes-mac)",
  );
  expect(readme).toContain(
    "Wait for copying to finish, then eject the disk image in Finder's sidebar.\n",
  );
  expect(readme).toContain(
    "You already use Hermes daily; here you connect that assistant to Caddy. Leave Hermes running.",
  );
  expect(human).toContain(
    "**Interview Mac, Tailscale app:** open the app, select the Hermes Mac and copy its Tailscale IPv4 address.",
  );
});

it("defines one local session target and guards every human and agent consumer", () => {
  expect(assignment).not.toBe("");
  expect(all.join("\n").match(/^\s*HERMES_SSH_TARGET=/gm)).toHaveLength(1);
  expect(consumers).toHaveLength(8);
  for (const command of consumers) {
    expect(command).toContain(guard);
    expect(command).not.toContain("shortname@");
    if (command.includes("/usr/bin/ssh "))
      expect(command).toMatch(/StrictHostKeyChecking=(yes|ask)/);
  }
  expect(human).toContain("same local Terminal tab");
  expect(human).toContain("exit");
  expect(human).toContain("0b746cc");
  expect(human).toContain("no PR #45 package");
  expect(agent).toContain("HERMES_SSH_TARGET");
  const enrollment =
    consumers.find((b) => b.includes("enroll-hermes-key.py")) ?? "";
  expect(enrollment).toContain('--public-key "$HOME/.ssh/id_ed25519.pub"');
});

it("renders each fenced command's literal bytes including quotes and fail-closed guards", () => {
  const html = renderSetupGuide(human);
  const decode = (s: string) =>
    s
      .replaceAll("&quot;", '"')
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&amp;", "&");
  const rendered = [
    ...html.matchAll(
      /<(?:pre|textarea)(?: [^>]*)?>([\s\S]*?)<\/(?:pre|textarea)>/g,
    ),
  ].map((m) => decode(m[1] ?? ""));
  expect(rendered).toEqual(blocks(human));
});

for (const shell of ["/bin/bash", "/bin/zsh"]) {
  const available = shellAvailable(
    shell,
    shellRequired(shell, process.platform),
  );
  if (!available)
    console.warn(
      `${shell} absent on ${process.platform}; zsh recipe coverage is required by the macOS native job.`,
    );
  describe.skipIf(!available)(shell, () => {
    function fixture(run: (root: string) => void) {
      const root = mkdtempSync(path.join(tmpdir(), "caddy-target-recipe-"));
      try {
        mkdirSync(path.join(root, "Resources"));
        run(root);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
    function execute(
      root: string,
      command: string,
      prefix: string,
      env: Record<string, string | undefined> = {},
    ) {
      // Replace executable entrypoints only. Never run SSH, keys, clipboard,
      // helper source, shasum, or Python; shell expansion itself stays literal.
      const injected = command
        .replaceAll("/usr/bin/ssh ", "fixture_ssh ")
        .replaceAll("/usr/bin/ssh-add ", "fixture_aux ")
        .replace(/^python3 /gm, "fixture_python ")
        .replace(/^cd .* &&$/gm, "true &&")
        .replace(/^printf .*\| shasum .* &&$/gm, "true &&")
        .replace(/^shasum .* &&$/gm, "true &&")
        .replaceAll(
          "/Applications/Convo Caddy.app/Contents/Resources",
          `${root}/Resources`,
        );
      return runShell(
        shell,
        [
          "-c",
          `fixture_ssh() { printf 'SSH'; printf '<%s>' "$@"; printf '\\n'; }\nfixture_python() { printf 'PYTHON'; printf '<%s>' "$@"; printf '\\n'; }\nfixture_aux() { printf 'AUX\\n'; }\n${prefix}\n${injected}`,
        ],
        {
          env: { HOME: root, PATH: "/usr/bin:/bin", ...env },
          encoding: "utf8",
          timeout: 5000,
        },
      );
    }
    it("dispatches every extracted consumer with one literal target, never splitting or evaluating it", () =>
      fixture((root) => {
        for (const value of [
          "reader@100.90.80.70",
          "reader@host; $(touch NOT_EXECUTED) with spaces",
        ]) {
          for (const command of consumers) {
            const result = execute(
              root,
              command,
              `HERMES_SSH_TARGET=${quote(value)}`,
            );
            expect(result.status, result.stderr).toBe(0);
            expect(result.stdout).toContain(`<${value}>`);
            if (command.includes("--public-key"))
              expect(result.stdout).toContain(`<${root}/.ssh/id_ed25519.pub>`);
          }
        }
      }));
    it.each(["unset HERMES_SSH_TARGET", "HERMES_SSH_TARGET=''"])(
      "prevents SSH/helper dispatch when %s",
      (prefix) =>
        fixture((root) => {
          for (const command of consumers) {
            const result = execute(root, command, prefix);
            expect(result.status).not.toBe(0);
            expect(result.stdout).not.toMatch(/SSH|PYTHON|AUX/);
            expect(result.stderr).toContain("Complete step 2");
          }
        }),
    );
    it("sets target only on a local shell with both installed helpers; failures clear stale target", () =>
      fixture((root) => {
        expect(assignment).not.toBe("");
        for (const file of ["acquire-hermes.py", "enroll-hermes-key.py"])
          writeFileSync(
            path.join(root, "Resources", file),
            "synthetic placeholder",
          );
        const set = assignment.replace(
          "shortname@100.101.102.103",
          "reader@100.90.80.70",
        );
        const consume = `fixture_ssh ${guard}`;
        const ok = execute(root, `${set}\n${consume}`, "");
        expect(ok.status, ok.stderr).toBe(0);
        expect(ok.stdout).toContain("SSH<reader@100.90.80.70>");
        for (const env of [
          { SSH_CONNECTION: "synthetic remote connection" },
          { SSH_TTY: "/synthetic/tty" },
        ]) {
          const stopped = execute(
            root,
            `${set}\n${consume}`,
            "HERMES_SSH_TARGET=stale",
            env,
          );
          expect(stopped.status).not.toBe(0);
          expect(stopped.stdout).not.toContain("SSH<");
          expect(stopped.stdout).toContain("local Terminal");
        }
        for (const missing of ["enroll-hermes-key.py", "acquire-hermes.py"]) {
          rmSync(path.join(root, "Resources", missing));
          const stopped = execute(
            root,
            `${set}\n${consume}`,
            "HERMES_SSH_TARGET=stale",
          );
          expect(stopped.status).not.toBe(0);
          expect(stopped.stdout).not.toContain("SSH<");
          expect(stopped.stdout).toContain("matching installer");
          writeFileSync(
            path.join(root, "Resources", missing),
            "synthetic placeholder",
          );
        }
      }));
  });
}

it("requires bash everywhere and zsh on macOS", () => {
  for (const platform of ["linux", "darwin"])
    expect(shellRequired("/bin/bash", platform)).toBe(true);
  expect(shellRequired("/bin/zsh", "darwin")).toBe(true);
  expect(shellRequired("/bin/zsh", "linux")).toBe(false);
});

it.each(["optional", "required", "execution"])(
  "diagnoses a missing shell: %s",
  (mode) => {
    const root = mkdtempSync(path.join(tmpdir(), "caddy-missing-shell-"));
    const missing = path.join(root, "missing-shell");
    try {
      if (mode === "optional")
        expect(shellAvailable(missing, false)).toBe(false);
      if (mode === "required")
        expect(() => shellAvailable(missing, true)).toThrow(
          /missing-shell.*ENOENT/,
        );
      if (mode === "execution")
        expect(() =>
          runShell(missing, ["-c", "true"], { encoding: "utf8" }),
        ).toThrow(/missing-shell.*ENOENT/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
