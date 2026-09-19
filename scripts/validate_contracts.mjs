#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import YAML from "yaml";

const root = process.cwd();
const docsRoot = path.join(root, "docs");

function walk(directory, suffix) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(target, suffix) : target.endsWith(suffix) ? [target] : [];
  });
}

function fencedObjects(file) {
  const source = fs.readFileSync(file, "utf8");
  const blocks = [];
  const pattern = /(?:^|\n)(```|~~~)(json|yaml)\s*\n([\s\S]*?)\n\1(?=\n|$)/g;
  for (const match of source.matchAll(pattern)) {
    try {
      const value = match[2] === "json" ? JSON.parse(match[3]) : YAML.parse(match[3]);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        blocks.push({ file, language: match[2], value });
      }
    } catch (error) {
      throw new Error(`${path.relative(root, file)} contains invalid ${match[2]}: ${error.message}`);
    }
  }
  return blocks;
}

function canonicalize(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite number in canonical document");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }
  throw new Error(`unsupported canonical value type: ${typeof value}`);
}

function definitionDigest(document, domain) {
  const projected = structuredClone(document);
  const claimed = projected.metadata?.digest;
  if (!claimed) throw new Error(`${document.kind} fixture has no metadata.digest`);
  delete projected.metadata.digest;
  const digest = crypto.createHash("sha256")
    .update(`${domain}\0`, "utf8")
    .update(canonicalize(projected), "utf8")
    .digest("hex");
  return { claimed, calculated: `sha256:${digest}` };
}

function assertValid(validate, fixture, label) {
  if (!validate(fixture)) {
    throw new Error(`${label} failed schema validation:\n${JSON.stringify(validate.errors, null, 2)}`);
  }
}

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  allowUnionTypes: true,
  validateFormats: true
});
addFormats(ajv);

const graphSpec = JSON.parse(fs.readFileSync(path.join(docsRoot, "contracts", "graph-spec.schema.json"), "utf8"));
const historyEvent = JSON.parse(fs.readFileSync(path.join(docsRoot, "contracts", "execution-history-event.schema.json"), "utf8"));
ajv.addSchema(graphSpec);
ajv.addSchema(historyEvent);

const blocks = walk(docsRoot, ".md").flatMap(fencedObjects);
const schemas = blocks.filter(({ value }) => value.$schema === "https://json-schema.org/draft/2020-12/schema");
const schemaById = new Map();
for (const { file, value } of schemas) {
  if (value.$id && schemaById.has(value.$id)) {
    throw new Error(`duplicate embedded schema id ${value.$id} in ${path.relative(root, file)}`);
  }
  const validate = ajv.compile(value);
  if (value.$id) schemaById.set(value.$id, validate);
}

const graphValidate = ajv.getSchema(graphSpec.$id);
const graphFixtures = blocks.filter(({ value }) => value.apiVersion === "executiongraph.io/v1" && value.kind === "Graph");
for (const { file, value } of graphFixtures) {
  assertValid(graphValidate, value, `${path.relative(root, file)} GraphSpec fixture`);
}

const fixtureSchemas = new Map([
  ["NodeDefinition", "https://schemas.ege.dev/node-definition/v1.json"],
  ["PluginPackage", "https://schemas.ege.dev/plugin-package/v1.json"],
  ["ToolDefinition", "https://schemas.ege.dev/tool-definition/v1.json"]
]);
for (const { file, value } of blocks) {
  const schemaId = fixtureSchemas.get(value.kind);
  if (schemaId) {
    const validate = schemaById.get(schemaId) ?? ajv.getSchema(schemaId);
    if (!validate) throw new Error(`missing schema ${schemaId} for ${value.kind}`);
    assertValid(validate, value, `${path.relative(root, file)} ${value.kind} fixture`);
  }
}

const compiledValidate = schemaById.get("urn:ege:compiled-plan-envelope:v1");
const compiledFixtures = blocks.filter(({ value }) => value.plan_format_version === "1.0" && value.graph && value.plan);
for (const { file, value } of compiledFixtures) {
  assertValid(compiledValidate, value, `${path.relative(root, file)} CompiledPlan fixture`);
}

for (const { file, value } of blocks.filter(({ value }) => value.kind === "NodeDefinition")) {
  const { claimed, calculated } = definitionDigest(value, "ege-node-definition-v1");
  if (claimed !== calculated) {
    throw new Error(`${path.relative(root, file)} NodeDefinition digest mismatch: claimed ${claimed}, calculated ${calculated}`);
  }
}
for (const { file, value } of blocks.filter(({ value }) => value.kind === "ToolDefinition")) {
  const { claimed, calculated } = definitionDigest(value, "ege-tool-definition-v1");
  if (claimed !== calculated) {
    throw new Error(`${path.relative(root, file)} ToolDefinition digest mismatch: claimed ${claimed}, calculated ${calculated}`);
  }
}

console.log(`strict schema validation passed: ${schemas.length + 2} schemas, ${graphFixtures.length} GraphSpec fixtures, ${compiledFixtures.length} CompiledPlan fixtures`);
