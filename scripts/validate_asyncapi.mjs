#!/usr/bin/env node

import process from "node:process";
import { Parser, fromFile } from "@asyncapi/parser";

const contract = "docs/contracts/execution-events.asyncapi.yaml";
const result = await fromFile(new Parser(), contract).parse();
if (!result.document || result.diagnostics.length > 0) {
  for (const diagnostic of result.diagnostics) {
    console.error(`${diagnostic.severity}: ${diagnostic.message}`);
  }
  process.exit(1);
}

console.log(`AsyncAPI semantic validation passed with zero diagnostics: ${contract}`);
