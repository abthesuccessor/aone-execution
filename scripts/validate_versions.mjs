#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";
import YAML from "yaml";

const root = process.cwd();
const lockPath = `${root}/versions.lock`;
const ddlPath = `${root}/scripts/validate_ddl.sh`;
const lock = YAML.parse(fs.readFileSync(lockPath, "utf8"));
const ddl = fs.readFileSync(ddlPath, "utf8");

function requireCondition(condition, message) {
  if (!condition) throw new Error(`versions.lock validation failed: ${message}`);
}

requireCondition(lock?.schema_version === 1, "schema_version must be 1");
requireCondition(lock?.kind === "ArchitectureVersionsLock", "unexpected kind");
requireCondition(typeof lock?.deployable === "boolean", "deployable must be boolean");
requireCondition(lock?.validation?.reject_floating_tags === true, "floating tags must be rejected");

const postgresPatch = lock?.release_pins?.postgresql_patch;
const postgresImage = lock?.validation_pins?.postgresql_image;
requireCondition(/^18\.[0-9]+$/.test(postgresPatch), "PostgreSQL validation patch must be an exact 18.x patch");
requireCondition(
  /^postgres@sha256:[0-9a-f]{64}$/.test(postgresImage),
  "PostgreSQL validation image must use an immutable manifest digest"
);
requireCondition(
  ddl.includes(`postgres_image="${postgresImage}"`),
  "validate_ddl.sh image differs from validation_pins.postgresql_image"
);
requireCondition(
  ddl.includes(`expected_postgres_version="${postgresPatch}"`),
  "validate_ddl.sh version assertion differs from release_pins.postgresql_patch"
);

if (lock.deployable) {
  for (const [name, value] of Object.entries(lock.release_pins ?? {})) {
    const resolved = Array.isArray(value) ? value.length > 0 : value !== null && value !== "";
    requireCondition(resolved, `deployable lock has unresolved release pin ${name}`);
  }
}

console.log(`version lock validation passed: PostgreSQL ${postgresPatch}, immutable validator image`);
