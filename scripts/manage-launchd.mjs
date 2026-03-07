#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const launchAgentsDir = path.join(os.homedir(), "Library", "LaunchAgents");
const logsDir = path.join(os.homedir(), ".openclaw", "logs");
const domain = `gui/${process.getuid()}`;
const serviceScript = path.join(rootDir, "scripts", "run-service.sh");
const pathValue =
  process.env.PATH ??
  "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

const services = [
  {
    kind: "api",
    label: "ai.openclaw.manus.api",
    stdout: path.join(logsDir, "manus-api.log"),
    stderr: path.join(logsDir, "manus-api.err.log")
  },
  {
    kind: "worker",
    label: "ai.openclaw.manus.worker",
    stdout: path.join(logsDir, "manus-worker.log"),
    stderr: path.join(logsDir, "manus-worker.err.log")
  }
];

const SECRET_NAME_PATTERN = /(key|token|secret|password)/i;

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: rootDir,
    stdio: options.stdio ?? "pipe",
    encoding: "utf8"
  });
}

function redactSecrets(output) {
  return output
    .split("\n")
    .map((line) => {
      const match = line.match(/^(\s*)([A-Z0-9_]+)\s=>\s(.*)$/);
      if (!match) {
        return line;
      }

      const [, indent, name] = match;
      if (!SECRET_NAME_PATTERN.test(name)) {
        return line;
      }

      return `${indent}${name} => [redacted]`;
    })
    .join("\n");
}

function sleepSeconds(seconds) {
  run("/bin/sleep", [String(seconds)], { stdio: "ignore" });
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function makePlist(service) {
  const envEntries = {
    HOME: os.homedir(),
    PATH: pathValue,
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    OPENCLAW_LAUNCHD_LABEL: service.label,
    OPENCLAW_SERVICE_KIND: service.kind,
    OPENCLAW_SERVICE_MARKER: "openclaw-manus"
  };

  const envXml = Object.entries(envEntries)
    .map(
      ([key, value]) =>
        `    <key>${xmlEscape(key)}</key>\n    <string>${xmlEscape(value)}</string>`
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${xmlEscape(service.label)}</string>
    <key>Comment</key>
    <string>openclaw-manus ${xmlEscape(service.kind)} service</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>WorkingDirectory</key>
    <string>${xmlEscape(rootDir)}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${xmlEscape(serviceScript)}</string>
      <string>${xmlEscape(service.kind)}</string>
    </array>
    <key>StandardOutPath</key>
    <string>${xmlEscape(service.stdout)}</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(service.stderr)}</string>
    <key>EnvironmentVariables</key>
    <dict>
${envXml}
    </dict>
  </dict>
</plist>
`;
}

function plistPathFor(service) {
  return path.join(launchAgentsDir, `${service.label}.plist`);
}

function ensureDirectories() {
  fs.mkdirSync(launchAgentsDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });
}

function ensureBuildArtifacts() {
  run("npm", ["run", "build"], { stdio: "inherit" });
  run("npm", ["run", "db:init"], { stdio: "inherit" });
}

function writePlists() {
  ensureDirectories();
  for (const service of services) {
    const plistPath = plistPathFor(service);
    try {
      fs.writeFileSync(plistPath, makePlist(service), "utf8");
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        ("code" in error && (error.code === "EPERM" || error.code === "EACCES")) &&
        fs.existsSync(plistPath)
      ) {
        continue;
      }
      throw error;
    }
  }
}

function bootoutIfLoaded(label) {
  try {
    run("launchctl", ["bootout", `${domain}/${label}`], { stdio: "pipe" });
  } catch {
    try {
      run("launchctl", ["bootout", domain, plistPathFor({ label })], { stdio: "pipe" });
    } catch {
      // Ignore missing services.
    }
  }
}

function bootstrapService(service) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      run("launchctl", ["bootstrap", domain, plistPathFor(service)], { stdio: "inherit" });
      lastError = undefined;
      break;
    } catch (error) {
      lastError = error;
      sleepSeconds(1);
    }
  }
  if (lastError) {
    throw lastError;
  }
  run("launchctl", ["kickstart", "-k", `${domain}/${service.label}`], { stdio: "inherit" });
}

function install() {
  ensureBuildArtifacts();
  writePlists();
  for (const service of services) {
    bootoutIfLoaded(service.label);
    bootstrapService(service);
  }
}

function restart() {
  ensureBuildArtifacts();
  writePlists();
  for (const service of services) {
    bootoutIfLoaded(service.label);
    sleepSeconds(1);
    bootstrapService(service);
  }
}

function stop() {
  for (const service of services) {
    bootoutIfLoaded(service.label);
  }
}

function uninstall() {
  stop();
  for (const service of services) {
    const plistPath = plistPathFor(service);
    if (fs.existsSync(plistPath)) {
      fs.unlinkSync(plistPath);
    }
  }
}

function status() {
  for (const service of services) {
    console.log(`\n== ${service.label} ==`);
    try {
      const output = run("launchctl", ["print", `${domain}/${service.label}`], {
        stdio: "pipe"
      });
      process.stdout.write(redactSecrets(output));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`failed to query ${service.label}: ${message}`);
      process.exitCode = 1;
    }
  }
}

function usage() {
  console.log(
    "usage: node scripts/manage-launchd.mjs <install|restart|stop|status|uninstall>"
  );
}

const command = process.argv[2] ?? "status";

switch (command) {
  case "install":
    install();
    break;
  case "restart":
    restart();
    break;
  case "stop":
    stop();
    break;
  case "status":
    status();
    break;
  case "uninstall":
    uninstall();
    break;
  default:
    usage();
    process.exitCode = 1;
    break;
}
