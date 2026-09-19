# 13. Plugin System

## 13.1 Trust boundary and goals

Plugins extend the data plane; they do not become part of the control plane. No marketplace or customer plugin is dynamically linked into the API server, compiler process, scheduler, coordinator, collaboration gateway, or web application's origin.

The system supports:

- custom node definitions and executors;
- tool adapters and MCP/OpenAPI tool registrations;
- provider connectors, serializers, validators, and expression functions with effect class and determinism `PURE`;
- schema-driven editor forms, documentation, icons, and optional isolated rich inspectors;
- public marketplace, organization-private registry, direct enterprise distribution, and offline bundles.

It does not support a plugin overriding authentication, authorization, audit, scheduling, state commit, secret brokering, Graph IR semantics, or built-in security gates. Those are platform policy points.

Every execution pins one `PluginPackage` content digest and one node-definition digest. Installing a newer version affects no published graph or running execution until an explicit upgrade and republish.

## 13.2 Package anatomy

A plugin is an OCI artifact with a fixed media type and content-addressed layers:

```text
application/vnd.ege.plugin.v1+json             OCI manifest
  +-- plugin.yaml                              signed semantic manifest
  +-- definitions/*.node.json                 node definitions and schemas
  +-- components/*.wasm                       preferred WASI components
  +-- images/*.descriptor.json                pinned OCI executor descriptors
  +-- ui/forms/*.ui.json                      declarative form/view definitions
  +-- ui/extension/*                          optional isolated iframe bundle
  +-- docs/*.md                               sanitized documentation
  +-- licenses/*
  +-- sbom.cdx.json                            CycloneDX SBOM
  +-- provenance.intoto.jsonl                 SLSA provenance
  +-- tests/plugin-test-bundle.tar.zst
```

Registry tags are discovery pointers. Installation records the OCI manifest digest, signature identity, transparency-log proof or enterprise attestation, scan report, and policy decision.

### 13.2.1 Manifest

```yaml
apiVersion: plugins.ege.dev/v1
kind: PluginPackage
metadata:
  name: acme/salesforce
  version: 4.0.1
  license: Apache-2.0
  source: https://github.example/acme/ege-salesforce
spec:
  compatibility:
    platformApi: ">=1.8 <2.0"
    nodeAbi: ">=1.3 <1.5"
    graphIr: [ege.dev/v1]
    architectures: [wasm32-wasip2, linux-amd64, linux-arm64]
  definitions:
    - id: acme/salesforce/query
      version: 3.1.0
      file: definitions/query.node.json
      executor:
        kind: wasm
        component: components/salesforce.wasm
        componentDigest: sha256:88c32c25f584bafe1dbf78f21ca84c663ec70d83a9f84b77be5825393c36943c
        export: query
      capabilityRequirements:
        - action: network.connect
          resource: {kind: connection, id: salesforce-api}
          constraints: {operations: [query], ports: [443]}
        - action: secret.use
          resource: {kind: secret_slot, id: oauth}
          constraints: {delivery: broker_proxy, reveal: false}
        - action: artifact.read
          resource: {kind: invocation_artifact, id: input}
          constraints: {maxBytes: 10485760}
        - action: artifact.write
          resource: {kind: invocation_artifact, id: output}
          constraints: {maxBytes: 10485760}
      optionalCapabilityRequirements:
        - action: telemetry.emit
          resource: {kind: telemetry_schema, id: acme-salesforce-custom-v1}
          constraints: {maxEvents: 100, payloadFields: allowlisted}
  egress:
    destinations:
      - id: salesforce-api
        scheme: https
        hostTemplate: "{tenant}.my.salesforce.com"
        ports: [443]
  secrets:
    slots:
      - id: oauth
        types: [oauth2]
        scopes: [api, refresh_token]
        delivery: broker-proxy
  dependencies:
    plugins:
      - { name: ege/http-common, range: ">=2.2 <3.0" }
  resources:
    default: { cpuMillis: 250, memoryMiB: 128, timeout: PT30S }
    maximum: { cpuMillis: 1000, memoryMiB: 512, timeout: PT2M }
  distribution:
    visibility: organization
    support: { url: "https://support.example/acme", tier: vendor }
```

The manifest schema rejects unknown fields. Extensions are accepted only inside the explicit, size-bounded root `extensions` map under a vendor-qualified key; core validators ignore them for authority, hashing them into the package envelope without treating them as executable configuration. `hostTemplate` placeholders are bound from administrator-approved connection profiles, not graph inputs, preventing graph authors from converting an approved origin into arbitrary egress.

### 13.2.2 Manifest validation excerpt

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://schemas.ege.dev/plugin-package/v1.json",
  "type": "object",
  "required": ["apiVersion", "kind", "metadata", "spec"],
  "additionalProperties": false,
  "$defs": {
    "sha256": {
      "type": "string",
      "pattern": "^sha256:[0-9a-f]{64}$"
    },
    "semver": {
      "type": "string",
      "pattern": "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\\+([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?$"
    },
    "capabilityRequirement": {
      "type": "object",
      "additionalProperties": false,
      "required": ["action", "resource", "constraints"],
      "properties": {
        "action": {"type": "string", "pattern": "^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$"},
        "resource": {
          "type": "object",
          "additionalProperties": false,
          "required": ["kind", "id"],
          "properties": {
            "kind": {"type": "string", "pattern": "^[a-z][a-z0-9_]{0,63}$"},
            "id": {"type": "string", "minLength": 1, "maxLength": 768},
            "version_digest": {"$ref": "#/$defs/sha256"}
          }
        },
        "constraints": {"type": "object", "maxProperties": 64}
      }
    },
    "executor": {
      "oneOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "required": ["kind", "implementationDigest", "entrypoint"],
          "properties": {
            "kind": {"const": "builtin"},
            "implementationDigest": {"$ref": "#/$defs/sha256"},
            "entrypoint": {"type": "string", "minLength": 1, "maxLength": 256}
          }
        },
        {
          "type": "object",
          "additionalProperties": false,
          "required": ["kind", "component", "componentDigest", "export"],
          "properties": {
            "kind": {"const": "wasm"},
            "component": {"type": "string", "pattern": "^[A-Za-z0-9._/-]{1,1024}$"},
            "componentDigest": {"$ref": "#/$defs/sha256"},
            "export": {"type": "string", "minLength": 1, "maxLength": 256}
          }
        },
        {
          "type": "object",
          "additionalProperties": false,
          "required": ["kind", "artifact", "artifactDigest", "entrypoint"],
          "properties": {
            "kind": {"const": "oci"},
            "artifact": {"type": "string", "minLength": 1, "maxLength": 1024},
            "artifactDigest": {"$ref": "#/$defs/sha256"},
            "entrypoint": {"type": "string", "minLength": 1, "maxLength": 256}
          }
        },
        {
          "type": "object",
          "additionalProperties": false,
          "required": ["kind", "connection", "service", "method", "protocolVersion", "descriptorDigest"],
          "properties": {
            "kind": {"const": "remote-grpc"},
            "connection": {"type": "string", "minLength": 1, "maxLength": 512},
            "service": {"type": "string", "minLength": 1, "maxLength": 512},
            "method": {"type": "string", "minLength": 1, "maxLength": 256},
            "protocolVersion": {"$ref": "#/$defs/semver"},
            "descriptorDigest": {"$ref": "#/$defs/sha256"}
          }
        }
      ]
    },
    "compatibility": {
      "type": "object",
      "additionalProperties": false,
      "required": ["platformApi", "nodeAbi", "graphIr", "architectures"],
      "properties": {
        "platformApi": {"type": "string", "minLength": 1, "maxLength": 128},
        "nodeAbi": {"type": "string", "minLength": 1, "maxLength": 128},
        "graphIr": {"type": "array", "minItems": 1, "maxItems": 16, "uniqueItems": true, "items": {"type": "string", "maxLength": 128}},
        "architectures": {"type": "array", "minItems": 1, "maxItems": 16, "uniqueItems": true, "items": {"enum": ["wasm32-wasip2", "linux-amd64", "linux-arm64"]}}
      }
    },
    "egress": {
      "type": "object",
      "additionalProperties": false,
      "required": ["destinations"],
      "properties": {
        "destinations": {
          "type": "array", "maxItems": 64,
          "items": {
            "type": "object", "additionalProperties": false,
            "required": ["id", "scheme", "hostTemplate", "ports"],
            "properties": {
              "id": {"type": "string", "pattern": "^[a-z][a-z0-9-]{0,63}$"},
              "scheme": {"const": "https"},
              "hostTemplate": {"type": "string", "pattern": "^[A-Za-z0-9.{}_-]{1,253}$"},
              "ports": {"type": "array", "minItems": 1, "maxItems": 16, "uniqueItems": true, "items": {"type": "integer", "minimum": 1, "maximum": 65535}}
            }
          }
        }
      }
    },
    "secrets": {
      "type": "object",
      "additionalProperties": false,
      "required": ["slots"],
      "properties": {
        "slots": {
          "type": "array", "maxItems": 64,
          "items": {
            "type": "object", "additionalProperties": false,
            "required": ["id", "types", "delivery"],
            "properties": {
              "id": {"type": "string", "pattern": "^[a-z][a-z0-9_-]{0,63}$"},
              "types": {"type": "array", "minItems": 1, "maxItems": 16, "uniqueItems": true, "items": {"type": "string", "maxLength": 64}},
              "scopes": {"type": "array", "maxItems": 64, "uniqueItems": true, "items": {"type": "string", "maxLength": 128}},
              "delivery": {"const": "broker-proxy"}
            }
          }
        }
      }
    },
    "dependencies": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "plugins": {
          "type": "array", "maxItems": 128,
          "items": {
            "type": "object", "additionalProperties": false,
            "required": ["name", "range"],
            "properties": {
              "name": {
                "type": "string",
                "pattern": "^[a-z0-9][a-z0-9.-]{0,62}(?:/[a-z0-9][a-z0-9.-]{0,62}){1,7}$",
                "maxLength": 256
              },
              "range": {"type": "string", "minLength": 1, "maxLength": 128}
            }
          }
        }
      }
    },
    "resourceProfile": {
      "type": "object", "additionalProperties": false,
      "required": ["cpuMillis", "memoryMiB", "timeout"],
      "properties": {
        "cpuMillis": {"type": "integer", "minimum": 1, "maximum": 128000},
        "memoryMiB": {"type": "integer", "minimum": 16, "maximum": 1048576},
        "timeout": {"type": "string", "format": "duration"}
      }
    },
    "resources": {
      "type": "object", "additionalProperties": false,
      "required": ["default", "maximum"],
      "properties": {
        "default": {"$ref": "#/$defs/resourceProfile"},
        "maximum": {"$ref": "#/$defs/resourceProfile"}
      }
    },
    "distribution": {
      "type": "object", "additionalProperties": false,
      "required": ["visibility", "support"],
      "properties": {
        "visibility": {"enum": ["private", "organization", "public"]},
        "support": {
          "type": "object", "additionalProperties": false,
          "required": ["url", "tier"],
          "properties": {
            "url": {"type": "string", "format": "uri"},
            "tier": {"enum": ["community", "vendor", "enterprise"]}
          }
        }
      }
    },
    "extensionScalar": {
      "oneOf": [
        {"type": "string"},
        {"type": "number"},
        {"type": "boolean"},
        {"type": "null"}
      ]
    },
    "extensionValue": {
      "oneOf": [
        {"$ref": "#/$defs/extensionScalar"},
        {"type": "array", "maxItems": 64, "items": {"$ref": "#/$defs/extensionScalar"}},
        {"type": "object", "maxProperties": 64, "additionalProperties": {"$ref": "#/$defs/extensionScalar"}}
      ]
    }
  },
  "properties": {
    "apiVersion": { "const": "plugins.ege.dev/v1" },
    "kind": { "const": "PluginPackage" },
    "metadata": {
      "type": "object",
      "additionalProperties": false,
      "required": ["name", "version", "license"],
      "properties": {
        "name": { "type": "string", "pattern": "^[a-z0-9][a-z0-9.-]*/[a-z0-9][a-z0-9.-]*$" },
        "version": {"$ref": "#/$defs/semver"},
        "license": { "type": "string", "minLength": 1 },
        "source": { "type": "string", "format": "uri" }
      }
    },
    "spec": {
      "type": "object",
      "additionalProperties": false,
      "required": ["compatibility", "definitions", "resources", "distribution"],
      "properties": {
        "compatibility": {"$ref": "#/$defs/compatibility"},
        "definitions": {
          "type": "array",
          "minItems": 1,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": ["id", "version", "file", "executor", "capabilityRequirements"],
            "properties": {
              "id": {"type": "string", "pattern": "^[a-z0-9][a-z0-9.-]*/[a-z0-9][a-z0-9./_-]{0,126}$"},
              "version": {"$ref": "#/$defs/semver"},
              "file": {"type": "string", "pattern": "^[A-Za-z0-9._/-]{1,1024}$"},
              "executor": {"$ref": "#/$defs/executor"},
              "capabilityRequirements": {
                "type": "array",
                "items": {"$ref": "#/$defs/capabilityRequirement"}
              },
              "optionalCapabilityRequirements": {
                "type": "array",
                "items": {"$ref": "#/$defs/capabilityRequirement"}
              }
            }
          }
        },
        "egress": {"$ref": "#/$defs/egress"},
        "secrets": {"$ref": "#/$defs/secrets"},
        "dependencies": {"$ref": "#/$defs/dependencies"},
        "resources": {"$ref": "#/$defs/resources"},
        "distribution": {"$ref": "#/$defs/distribution"}
      }
    },
    "extensions": {
      "type": "object",
      "maxProperties": 32,
      "propertyNames": {"pattern": "^[a-z0-9][a-z0-9.-]*/[a-z0-9][a-z0-9._-]{0,63}$"},
      "additionalProperties": {"$ref": "#/$defs/extensionValue"}
    }
  }
}
```

## 13.3 Plugin SDK

The SDK contains:

- manifest, node-definition, port, configuration, and UI-schema builders;
- generated ABI bindings for Rust, TypeScript/JavaScript Component Model, Go, and Python component adapters;
- a local capability broker, artifact handles, structured telemetry, cancellation, deadlines, and seeded clock/random interfaces;
- contract-test fixtures for duplicate delivery, lease loss, cancellation, timeout, output validation, capability denial, and artifact corruption;
- packaging, SBOM, provenance, reproducible build, signing, and conformance commands;
- no client that writes execution state or fetches raw platform credentials.

The preferred ABI is the WebAssembly Component Model/WASI Preview 2. Native OCI or remote gRPC executors use the same sanitized `SandboxInvocation`/`SandboxResult` semantic contract and are assigned a stronger isolation profile. The envelope contains typed inputs, opaque artifact handles, a deadline, and local host-channel metadata; it contains no `ExecutionGrant`, broker subject, database coordinate, or secret.

### 13.3.1 WIT boundary

```wit
package ege:node@1.3.0;

interface host {
  record artifact-handle { id: string, media-type: string, size: u64 }
  record capability-error { code: string, safe-detail: string }
  read-artifact: func(handle: artifact-handle, offset: u64, limit: u32)
    -> result<list<u8>, capability-error>;
  write-artifact: func(media-type: string, bytes: list<u8>)
    -> result<artifact-handle, capability-error>;
  http: func(connection: string, operation: string, request: list<u8>)
    -> result<list<u8>, capability-error>;
  emit-log: func(event-schema: string, fields: list<tuple<string, string>>);
  cancelled: func() -> bool;
}

interface executor {
  invoke: func(invocation: list<u8>) -> result<list<u8>, string>;
}

world node-component {
  import host;
  export executor;
}
```

Imports are capability-shaped proxies. The Wasm component has no ambient sockets, DNS, filesystem, environment, wall clock, randomness, or secret values. An invocation receives deterministic clock/seed data when declared. `host.http` accepts an installed connection ID and registered operation, not an arbitrary URL.

### 13.3.2 Rust custom node

```rust
use ege_plugin_sdk::{node, Config, Invocation, NodeError, Outcome};
use serde::{Deserialize, Serialize};

#[derive(Config, Deserialize)]
#[config(deny_unknown_fields)]
struct QueryConfig {
    connection: String,
    #[validate(range(min = 1, max = 2000))]
    page_size: u16,
}

#[derive(Deserialize)]
struct QueryInput { soql_template: String, parameters: serde_json::Value }

#[derive(Serialize)]
struct QueryOutput { records_artifact: String, count: u64 }

#[node(id = "acme/salesforce/query", version = "3.1.0")]
async fn query(inv: Invocation<QueryInput, QueryConfig>) -> Result<Outcome<QueryOutput>, NodeError> {
    inv.check_cancelled()?;
    let request = compile_registered_query(&inv.input.soql_template, &inv.input.parameters)?;
    let response = inv.host().http(&inv.config.connection, "query", request).await?;
    let artifact = inv.host().artifacts().write_arrow(response.into_batches()?).await?;
    Ok(Outcome::completed(QueryOutput {
        records_artifact: artifact.id,
        count: artifact.row_count,
    }))
}
```

The macro generates the definition skeleton and JSON Schemas, but publication rejects inferred schemas with unconstrained `any`, unbounded strings/arrays, or undocumented errors. Authors commit the generated definition for review.

### 13.3.3 TypeScript plugin test

```ts
import { contractTest, invocation } from "@ege/plugin-test";
import plugin from "../dist/acme-salesforce.wasm";

contractTest("query denies undeclared egress", plugin, async (h) => {
  h.http.deny("salesforce", { code: "EGRESS_DESTINATION_DENIED" });
  const result = await h.invoke(invocation({
    node: "acme/salesforce/query@3.1.0",
    config: { connection: "salesforce", pageSize: 100 },
    input: { soqlTemplate: "active_leads", parameters: {} }
  }));
  h.expectFailure(result, { code: "EGRESS_DESTINATION_DENIED", retryable: false });
  h.expectNoUndeclaredCapabilities();
  h.expectNoSecretMaterialInLogs();
});
```

## 13.4 Custom node definition

Each custom node supplies the complete closed Chapter 4 contract, with optional authoring metadata:

```json
{
  "apiVersion": "ege.dev/v1",
  "kind": "NodeDefinition",
  "metadata": {
    "name": "acme/salesforce/query",
    "version": "3.1.0",
    "digest": "sha256:4b985bf3bda155b52e156ab38cf44ae1a50e9c488b4b57fc2fb8dd7f96a1d33d",
    "displayName": "Salesforce Query",
    "categories": ["integration", "crm"]
  },
  "spec": {
    "ports": {
      "inputs": {
        "parameters": {
          "schema": { "type": "object", "maxProperties": 50 },
          "cardinality": "one",
          "classification": "CONFIDENTIAL"
        }
      },
      "outputs": {
        "records": {
          "schema": { "$ref": "schemas/RecordBatchRef@1" },
          "cardinality": "one",
          "classification": "CONFIDENTIAL",
          "storage": "artifact"
        }
      }
    },
    "configSchema": {
      "type": "object",
      "required": ["connection", "statement", "pageSize"],
      "additionalProperties": false,
      "properties": {
        "connection": { "type": "string", "x-ege-control": "connection-ref" },
        "statement": { "type": "string", "x-ege-control": "registered-operation" },
        "pageSize": { "type": "integer", "minimum": 1, "maximum": 2000 }
      }
    },
    "effect": {
      "class": "READ_ONLY",
      "deliveryContract": "READ_ONLY_REPEATABLE",
      "allowedAdapterEffectModes": ["SUBSTITUTE_RECORDED", "REEXECUTE_READ_ONLY"]
    },
    "executor": {
      "kind": "wasm",
      "artifact": "oci://registry.ege.dev/acme/salesforce-query@sha256:4d2f5c631d5d246c515787105651811461dbda4f01298d998bdfa576e62b637d",
      "entrypoint": "query"
    },
    "capabilities": [
      {
        "action": "network.connect",
        "resource": {"kind": "connection", "id": "salesforce-api"},
        "constraints": {"operations": ["query"], "ports": [443]}
      },
      {
        "action": "secret.use",
        "resource": {"kind": "secret_slot", "id": "oauth"},
        "constraints": {"delivery": "broker_proxy", "reveal": false}
      },
      {
        "action": "artifact.write",
        "resource": {"kind": "invocation_artifact", "id": "output"},
        "constraints": {"maxBytes": 10485760}
      }
    ],
    "determinism": "RECORDED_NONDETERMINISTIC",
    "resources": {
      "default": {"cpuMillis": 250, "memoryMiB": 256, "timeout": "PT20S"},
      "maximum": {"cpuMillis": 1000, "memoryMiB": 1024, "timeout": "PT2M"}
    },
    "errors": [
      {
        "code": "CRM_RATE_LIMITED",
        "category": "RUNTIME_ERROR_CATEGORY_PROVIDER",
        "gatewayRetryClass": "RETRY_CONDITIONALLY"
      },
      {
        "code": "CRM_QUERY_REJECTED",
        "category": "RUNTIME_ERROR_CATEGORY_USER",
        "gatewayRetryClass": "DO_NOT_RETRY"
      }
    ]
  },
  "authoring": {
    "docs": "docs/query.md",
    "icon": "assets/salesforce.svg",
    "form": "ui/forms/query.ui.json"
  }
}
```

The platform derives a safe form from `configSchema`. Declarative `x-ege-control` hints can choose a platform-owned secret, connection, model, schema, or policy picker but cannot relax authorization or retrieve secret bytes.

An optional rich UI extension runs in a sandboxed iframe on a separate origin with `allow-scripts` only, restrictive CSP, no same-origin, no top navigation, and a versioned `postMessage` RPC. It receives schema-valid redacted data and can propose JSON Patches. The host validates and applies patches. Marketplace HTML/Markdown/SVG is sanitized; SVG scripts, external resources, and event handlers are rejected.

## 13.5 Tool Registry

The Tool Registry is the authoritative catalog of callable tools independent of discovery protocol. MCP, OpenAPI, gRPC, built-in functions, and plugin tools normalize to one immutable `ToolDefinition`. Registry admission validates the following closed schema; like NodeDefinition, its only external schema dependency is the pinned canonical GraphSpec effect vocabulary:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://schemas.ege.dev/tool-definition/v1.json",
  "type": "object",
  "additionalProperties": false,
  "required": ["apiVersion", "kind", "metadata", "spec"],
  "$defs": {
    "uuidv7": {
      "type": "string",
      "format": "uuid",
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    },
    "sha256": {"type": "string", "pattern": "^sha256:[0-9a-f]{64}$"},
    "semver": {
      "type": "string",
      "pattern": "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\\+([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?$"
    },
    "capabilityRequirement": {
      "type": "object",
      "additionalProperties": false,
      "required": ["action", "resource", "constraints"],
      "properties": {
        "action": {
          "type": "string",
          "pattern": "^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$",
          "maxLength": 128
        },
        "resource": {
          "type": "object",
          "additionalProperties": false,
          "required": ["kind", "id"],
          "properties": {
            "kind": {"type": "string", "pattern": "^[a-z][a-z0-9_]{0,63}$"},
            "id": {"type": "string", "minLength": 1, "maxLength": 768},
            "version_digest": {"$ref": "#/$defs/sha256"}
          }
        },
        "constraints": {"type": "object", "maxProperties": 64}
      }
    },
    "transport": {
      "oneOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "required": ["kind", "server", "remoteName", "protocolRange"],
          "properties": {
            "kind": {"const": "mcp"},
            "server": {"type": "string", "minLength": 1, "maxLength": 512},
            "remoteName": {"type": "string", "minLength": 1, "maxLength": 256},
            "protocolRange": {"type": "string", "minLength": 1, "maxLength": 128}
          }
        },
        {
          "type": "object",
          "additionalProperties": false,
          "required": ["kind", "connection", "operationId", "documentDigest"],
          "properties": {
            "kind": {"const": "openapi"},
            "connection": {"type": "string", "minLength": 1, "maxLength": 512},
            "operationId": {"type": "string", "minLength": 1, "maxLength": 256},
            "documentDigest": {"$ref": "#/$defs/sha256"}
          }
        },
        {
          "type": "object",
          "additionalProperties": false,
          "required": ["kind", "service", "method", "descriptorDigest"],
          "properties": {
            "kind": {"const": "grpc"},
            "service": {"type": "string", "minLength": 1, "maxLength": 512},
            "method": {"type": "string", "minLength": 1, "maxLength": 256},
            "descriptorDigest": {"$ref": "#/$defs/sha256"}
          }
        },
        {
          "type": "object",
          "additionalProperties": false,
          "required": ["kind", "implementationDigest", "entrypoint"],
          "properties": {
            "kind": {"const": "builtin"},
            "implementationDigest": {"$ref": "#/$defs/sha256"},
            "entrypoint": {"type": "string", "minLength": 1, "maxLength": 256}
          }
        }
      ]
    }
  },
  "properties": {
    "apiVersion": {"const": "tools.ege.dev/v1"},
    "kind": {"const": "ToolDefinition"},
    "metadata": {
      "type": "object",
      "additionalProperties": false,
      "required": ["id", "name", "version", "digest"],
      "properties": {
        "id": {"$ref": "#/$defs/uuidv7"},
        "name": {
          "type": "string",
          "pattern": "^[a-z0-9][a-z0-9.-]{0,62}(?:/[a-z0-9][a-z0-9.-]{0,62}){1,7}$",
          "maxLength": 256
        },
        "version": {"$ref": "#/$defs/semver"},
        "digest": {"$ref": "#/$defs/sha256"}
      }
    },
    "spec": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "transport", "inputSchema", "outputSchema", "effect", "determinism",
        "capabilityRequirements", "dataPolicy", "limits"
      ],
      "properties": {
        "transport": {"$ref": "#/$defs/transport"},
        "inputSchema": {"type": "object"},
        "outputSchema": {"type": "object"},
        "effect": {
          "allOf": [
            {"$ref": "https://schemas.execution-graph.example/v1/graph-spec.schema.json#/$defs/effect"},
            {
              "type": "object",
              "required": ["allowedAdapterEffectModes"],
              "properties": {"allowedAdapterEffectModes": true}
            }
          ]
        },
        "determinism": {"enum": ["PURE", "RECORDED_NONDETERMINISTIC", "EFFECTFUL"]},
        "capabilityRequirements": {
          "type": "array",
          "items": {"$ref": "#/$defs/capabilityRequirement"},
          "minItems": 1,
          "maxItems": 128,
          "uniqueItems": true
        },
        "dataPolicy": {
          "type": "object",
          "additionalProperties": false,
          "required": ["acceptedLabels", "outputLabel"],
          "properties": {
            "acceptedLabels": {
              "type": "array",
              "items": {"enum": ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED"]},
              "minItems": 1,
              "maxItems": 4,
              "uniqueItems": true
            },
            "outputLabel": {"enum": ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED"]}
          }
        },
        "limits": {
          "type": "object",
          "additionalProperties": false,
          "required": ["timeout", "maxInputBytes", "maxOutputBytes", "maxCalls"],
          "properties": {
            "timeout": {"type": "string", "format": "duration"},
            "maxInputBytes": {"type": "integer", "minimum": 1, "maximum": 1073741824},
            "maxOutputBytes": {"type": "integer", "minimum": 1, "maximum": 1073741824},
            "maxCalls": {"type": "integer", "minimum": 1, "maximum": 4096}
          }
        }
      }
    }
  }
}
```

One validated definition:

```yaml
apiVersion: tools.ege.dev/v1
kind: ToolDefinition
metadata:
  id: 0197f3c2-8d00-7ddd-bf65-64c700000021
  name: acme.crm/create-case
  version: 2.2.0
  digest: sha256:9f5a02fc22933b1f818b7fbddb61447e8c4a78b188c92ea9651c4865e2547135
spec:
  transport:
    kind: mcp
    server: connections/acme-crm-mcp
    remoteName: create_case
    protocolRange: ">=2026-03-01 <2027-01-01"
  inputSchema: { $ref: schemas/CreateCase@2 }
  outputSchema: { $ref: schemas/CaseReceipt@1 }
  effect:
    class: IDEMPOTENT_WRITE
    deliveryContract: DESTINATION_IDEMPOTENCY
    idempotencyKey: input.request_id
    reconciliationProcedure: tool://acme.crm/get-case-by-request-id@1
    allowedAdapterEffectModes: [SUBSTITUTE_RECORDED, REEXECUTE_AUTHORIZED_EFFECT]
  determinism: EFFECTFUL
  capabilityRequirements:
    - action: tool.invoke
      resource: {kind: tool, id: acme.crm/create-case}
      constraints: {transport: mcp, operation: create_case, maxCalls: 1}
  dataPolicy:
    acceptedLabels: [PUBLIC, INTERNAL, CONFIDENTIAL]
    outputLabel: CONFIDENTIAL
  limits: { timeout: PT20S, maxInputBytes: 65536, maxOutputBytes: 1048576, maxCalls: 1 }
```

Registration flow:

1. An administrator creates a connection profile and authentication binding.
2. A discovery worker retrieves MCP tools or an OpenAPI document through the egress broker.
3. The registry normalizes names and schemas, rejects unsupported/unbounded constructs, and stores raw discovery material as provenance.
4. An administrator reviews effects, idempotency, data labels, destinations, permissions, rate limits, and descriptions. Discovery cannot self-assert trust.
5. Approval publishes a version/digest. Graphs and agents pin that digest.
6. Periodic rediscovery creates a drift report. It never mutates an approved definition.

`ToolDefinition.metadata.digest` uses the same non-self-referential rule as NodeDefinition with the distinct domain `ege-tool-definition-v1\0`: RFC 8785 canonicalize the complete ToolDefinition after omitting only `metadata.digest`, prefix the domain, and SHA-256 the resulting bytes. Registration and lookup recompute the value; transport discovery can propose a document but cannot choose its digest or rebind an existing version.

Tool descriptions are untrusted provider content. They can inform users and models only after sanitization and are never interpreted as permission. An Agent receives an execution-scoped tool list already intersected with its grants.

### 13.5.1 Local Agent Skills adapter

The local harness may discover Agent Skills from configured roots such as
`~/.agents/skills`. Its informative file-format baseline is the
[Agent Skills specification](https://agentskills.io/specification). Agent Skills are
instruction/resource packages for a model harness; they are not EGE plugins,
`ToolDefinition` values, executable graph nodes, or capability grants.

Discovery follows progressive disclosure:

1. enumerate direct skill directories without following a symlink outside the
   configured real path;
2. validate `SKILL.md` YAML frontmatter, including required lowercase `name` matching
   the parent directory and non-empty `description`;
3. expose only validated name, description, compatibility, license and content digest
   in the authoring palette;
4. after a user selects a skill for a node, load the entire `SKILL.md` instructions;
5. load referenced `scripts/`, `references/` or `assets/` files only when the approved
   plan and active node require them; and
6. record every loaded relative path and digest in the node context manifest.

The snapshot digest covers `SKILL.md` plus the selected resource manifest using a
domain-separated canonical encoding. A plan pins that digest. Changing a selected
skill creates a new candidate context and invalidates any approval bound to the old
digest.

The Agent Skills `allowed-tools` field is experimental, provider-specific metadata. It
MUST NOT grant a platform capability. Effective tools are the intersection of the
compiled node requirements, environment policy, user approval, provider support and
runtime capability grant. A skill script is inert content until an authorized sandbox
invokes its exact digest with explicit filesystem, network, process, time and output
limits. Model-generated shell strings are never accepted as the script launcher.

Remote/cloud environments do not read a developer's home directory. Promoting a local
skill requires packaging the same content as a signed, digest-pinned organization
artifact and passing normal installation, policy and execution gates.

## 13.6 Capability and permission model

Plugins request authority only through the structured contract below. Colon-delimited permission grammars are not accepted because their parsing and wildcard semantics drift across SDKs.

```typescript
type CapabilityRequirement = {
  action: string;
  resource: { kind: string; id: string; version_digest?: string };
  constraints: Record<string, unknown>;
};
```

Effective authority is the field-by-field narrowing of requirements:

```text
manifest CapabilityRequirement
  INTERSECT organization installation grant
  INTERSECT project/environment policy
  INTERSECT graph/node grant
  INTERSECT execution principal authority
  INTERSECT current policy snapshot and approval
  INTERSECT attempt-scoped ExecutionGrant
```

| Action | Resource example | Constraint examples | Gateway enforcement |
|---|---|---|---|
| `artifact.read`, `artifact.write` | `{kind: invocation_artifact, id: input}` | classification, namespace, bytes, media type | Opaque handles; tenant and invocation ownership checks |
| `network.connect` | `{kind: connection, id: salesforce-api}` | registered operations, host/port, method | Egress proxy, SSRF-safe resolution, byte/time/rate limits |
| `secret.use` | `{kind: secret_slot, id: oauth}` | operation, broker delivery, reveal false | Secret broker uses the credential on the plugin's behalf; raw value never enters sandbox |
| `database.execute` | `{kind: database_profile, id: customer-readonly}` | statement IDs, transaction/read mode, row/byte cap | Database proxy with prepared operations, RLS, and limits; no sandbox DB client |
| `tool.invoke` | `{kind: tool, id: acme.crm/create-case}` | exact version digest, operation, call cap | Tool gateway validates schema, current grant, policy, and destination |
| `model.invoke` | `{kind: model_profile, id: support-balanced}` | operation, data labels, token/cost cap | Model gateway chooses an eligible provider and accounts usage |
| `event.publish` | `{kind: event_contract, id: case-updated-v2}` | direction, schema digest, rate | Event gateway tenant-prefixes and uses outbox/dedupe; sandbox never uses NATS |
| `state.read_projection` | `{kind: state_projection, id: declared-inputs}` | declared JSON pointers, byte cap | Gateway supplies a snapshot projection; no state-store credentials |
| `telemetry.emit` | `{kind: telemetry_schema, id: plugin-events-v1}` | instruments, fields, rate, cardinality | Redaction, cardinality, size, and rate controls |
| `runtime.observe` | `{kind: runtime_service, id: logical-clock}` | clock/random source and determinism contract | Host records or supplies values; replay behavior uses the selected adapter effect mode |

“Network access,” “all secrets,” and wildcard production grants are not acceptable marketplace defaults. Optional requirements are disabled until explicitly granted. A grant increase during upgrade requires fresh administrator approval even for a semver patch. `WorkerGateway` mints the resulting proof-of-possession/mTLS-bound `ExecutionGrant` and persists its hash/constraints; `WorkerSupervisor` may hold and present it only on gateway RPCs. The plugin receives only callable host functions and opaque handles.

Plugin replay declarations use the platform's three independent axes. The operation is `STATE_REBUILD`, `EXACT_REPLAY`, or `FORKED_REPLAY`; `execution_mode` is `LIVE`, `REPLAY`, or `SIMULATION`; and each adapter call uses `SUBSTITUTE_RECORDED`, `REEXECUTE_READ_ONLY`, `REEXECUTE_AUTHORIZED_EFFECT`, or `FORBID`. Legacy plugin values such as `record`, `recompute`, `shadow`, or `side_effecting` are rejected rather than guessed. A plugin declares one effect class—`PURE`, `READ_ONLY`, `IDEMPOTENT_WRITE`, `COMPENSATABLE_WRITE`, `NON_IDEMPOTENT_WRITE`, or `HUMAN_EFFECT`—and separately one determinism value—`PURE`, `RECORDED_NONDETERMINISTIC`, or `EFFECTFUL`.

## 13.7 Sandboxing and runtime hosts

### 13.7.1 Execution profiles

| Profile | Workload | Isolation and limits | Allowed host surface |
|---|---|---|---|
| Wasm component | Preferred `PURE` and adapter plugins | Fresh instance or tenant/digest-keyed pool; memory cap, fuel, epoch deadline | WIT capability imports only |
| Sandboxed OCI | Native libraries, large language runtimes | Non-root, read-only root, user namespace, seccomp/AppArmor, dropped capabilities, cgroup, gVisor/Kata | Unix/gRPC capability sidecar; no Kubernetes API |
| MicroVM | High-risk native/community plugin | Firecracker/Kata VM, ephemeral encrypted disk, dedicated network namespace | Same brokered protocol with stricter quotas |
| Remote enterprise | On-prem/private service | mTLS workload identity, attested digest/version, allowlisted endpoint, concurrency/rate circuit | Node protocol and artifact/capability gateway only |

`WorkerSupervisor` is the trusted JetStream consumer and manages these runtime profiles. It may hold/present a proof-of-possession/mTLS-bound `ExecutionGrant`, but cannot use it for direct database, broker, or secret access. `WorkerGateway` alone claims/commits PostgreSQL work, mints the grant, persists its hash/constraints, validates supervisor RPCs and fencing, and invokes trusted brokers. All sandboxes deny NATS, database, ambient network, and ambient filesystem access and receive only opaque capability handles—no grant or secret. Scratch storage is bounded and destroyed after invocation. Warm instances are keyed by tenant, plugin digest, policy epoch, and narrowed requirement set; never shared across tenants or widened grants. Lease expiry fences result commit. Sandbox destruction does not imply external-effect rollback.

### 13.7.2 Resource enforcement

Admission clamps plugin requests to package maximum, installation policy, environment class, tenant quota, and execution budget. CPU, memory, file descriptors, threads, processes, artifact bytes, host calls, network bytes, log bytes, metric cardinality, wall time, and fuel all have limits. Exceeding one produces a stable `resource` error and increments abuse/rate signals; it cannot crash the worker node.

## 13.8 Dependency management and compatibility

### 13.8.1 Resolution

Plugin dependencies are resolved at installation, then written as exact digests to an installation lock. The resolver:

1. filters versions by platform API, node ABI, Graph IR, architecture, organization policy, signature trust, vulnerability policy, and revocation;
2. applies semantic version constraints and selects one deterministic highest eligible solution;
3. rejects dependency cycles and conflicting singleton protocol packages;
4. fetches and verifies every transitive artifact before activation;
5. stores a dependency graph and “why installed” path.

No `npm install`, `pip install`, Cargo fetch, shell installer, or network package resolution runs at node invocation. Language dependencies are compiled into the Wasm component or pinned OCI image and appear in the SBOM. Plugins do not share mutable `node_modules`, Python environments, dynamic libraries, or filesystem layers at runtime.

### 13.8.2 Compatibility rules

| Change | Node definition semver | Graph impact |
|---|---|---|
| Add optional input/config with default; add output | Minor | Existing instances valid; consumers opt in |
| Widen accepted input schema without changing effect | Minor | Existing edges valid; recompile recommended |
| Remove/rename/narrow port; make config required | Major | Publication blocked until migration |
| Add a required `CapabilityRequirement` or broaden among `PURE`, `READ_ONLY`, `IDEMPOTENT_WRITE`, `COMPENSATABLE_WRITE`, `NON_IDEMPOTENT_WRITE`, `HUMAN_EFFECT` | Major regardless of code compatibility | Fresh install grant and graph review required |
| Fix implementation without contract/effect/permission change | Patch | Existing graph remains pinned; operator chooses upgrade |
| Change determinism (`PURE`, `RECORDED_NONDETERMINISTIC`, `EFFECTFUL`), adapter effect modes, or idempotency | Major | Replay and operational review required; determinism never substitutes for effect class review |
| Documentation/icon/form hint only | Patch | Creates a new immutable NodeDefinition digest because authoring is integrity-covered; authoring is excluded only from the compiled semantic `plan_hash`, and existing graphs remain pinned until an explicit upgrade |

The compatibility checker uses schema subsumption plus explicit semantic declarations. JSON Schema equivalence is undecidable in general; inconclusive analysis fails conservative and requires a major upgrade/migration. A package version and a node-definition version are separate: one package can ship several nodes on independent contracts.

### 13.8.3 Migration

A plugin may ship a config migration whose effect class and determinism are both `PURE`. It runs in the Wasm sandbox with old config and returns new config plus warnings. The platform shows the exact JSON Patch, `CapabilityRequirement`, effect-class, and determinism diff. Migration never edits published versions; it creates a draft command. Data/state migrations are separate governed graphs, not hidden install hooks.

## 13.9 Signing, provenance, and verification

Publish requires:

- an OCI manifest digest and per-layer digest;
- an SBOM covering source and binary dependencies;
- SLSA provenance linking source revision, hermetic builder identity, build parameters, and artifact digest;
- a Sigstore-compatible keyless signature anchored to an accepted identity, or an enterprise offline certificate chain;
- conformance results and declared security contacts;
- malware, secret, license, vulnerability, manifest, ABI, and behavior scans.

The marketplace uses a TUF-style signed metadata hierarchy for root trust, targets, snapshot, timestamp, delegation, expiry, and rollback protection. Transparency inclusion is verified where reachable and stapled for offline use. Verification is repeated at download, installation, activation, and worker materialization—not only at marketplace upload.

Signature proves provenance, not safety. Policy independently evaluates publisher trust, scan age, known vulnerabilities, requested capabilities, executor profile, support status, and tenant risk tolerance.

### 13.9.1 Revocation

Revocation can target publisher identity, package digest, node-definition digest, signing certificate, or vulnerable dependency digest. Policy chooses:

- `block-new`: no new install, publish, deployment, or execution;
- `drain`: stop scheduling new attempts and allow bounded current attempts;
- `kill`: cancel/fence attempts immediately for active exploitation;
- `warn`: allow under time-bounded exception with owner and reason.

Historical graph/execution records retain metadata and digest. Artifacts are quarantined from reuse rather than deleted from evidence. A rollback is allowed only to a non-revoked compatible digest.

## 13.10 Marketplace and registries

### 13.10.1 Services

```text
Publisher CLI --> upload quarantine --> verifier/scanners --> review/policy --> OCI registry
                                                                |
                                                                +--> catalog/search index
                                                                +--> signed metadata service

Organization admin --> install plan --> compatibility + permission diff --> approval
                                                                |
                                                                +--> tenant installation lock
                                                                +--> runtime artifact mirror
```

The marketplace record includes exact versions/digests, publisher verification, support, release notes, compatibility, structured capability requirements, egress, data handling, effect classes, determinism, resource maxima, SBOM/license, provenance, scan status/age, advisories, install counts, and independently verified reviews. Rank does not override organization policy.

Public reviews require a verified installation and distinguish documentation, reliability, security disclosure response, and support. Reviews and download counts are abuse-resistant and never treated as security certification.

### 13.10.2 Installation plan API

```http
POST /v1/organizations/0197f3c2-8e00-7eee-8076-75d800000022/plugins:planInstall
Idempotency-Key: 0197f3c2-8f00-7fff-9187-86e900000023
Content-Type: application/json

{
  "package": "acme/salesforce",
  "version": "4.0.1",
  "expectedDigest": "sha256:805e...22f9",
  "environmentScopes": ["0197f3c2-9000-7000-a298-97fa00000024"],
  "requestedOptionalCapabilityRequirements": []
}
```

```json
{
  "planId": "0197f3c2-9100-7111-b3a9-a80b00000025",
  "expiresAt": "2026-08-06T04:00:00Z",
  "packageDigest": "sha256:805e...22f9",
  "dependencies": [
    { "name": "ege/http-common", "version": "2.4.0", "digest": "sha256:9ec1..." }
  ],
  "capabilityRequirementDiff": {
    "required": [
      {
        "action": "network.connect",
        "resource": {"kind": "connection", "id": "salesforce-api"},
        "constraints": {"operations": ["query"], "ports": [443]}
      },
      {
        "action": "secret.use",
        "resource": {"kind": "secret_slot", "id": "oauth"},
        "constraints": {"delivery": "broker_proxy", "reveal": false}
      }
    ],
    "new": [
      {
        "action": "secret.use",
        "resource": {"kind": "secret_slot", "id": "oauth"},
        "constraints": {"delivery": "broker_proxy", "reveal": false}
      }
    ]
  },
  "egress": ["https://{approved-tenant}.my.salesforce.com:443"],
  "risk": { "decision": "approval_required", "reasons": ["NEW_SECRET_USE", "EXTERNAL_EGRESS"] },
  "planDigest": "sha256:21ab...9c03"
}
```

Applying requires the exact unexpired `planDigest`, current policy epoch, and required approvers. A changed tag, signature, scan, dependency, vulnerability, permission, or policy invalidates the plan.

### 13.10.3 Distribution modes

| Mode | Discovery and trust | Use case |
|---|---|---|
| Public marketplace | Platform catalog, delegated publishers, transparency and platform policy | Broad reusable integrations |
| Organization private | Tenant registry namespace and organization trust roots | Proprietary nodes and internal connectors |
| Direct enterprise | Digest-addressed private OCI registry with explicit trust policy | Vendor/customer bilateral distribution |
| Offline bundle | Signed catalog snapshot, artifacts, SBOMs, proofs, revocation snapshot, expiry | Air-gapped environments |

Offline import verifies the whole bundle and records that revocation freshness is bounded by snapshot time. Export does not include connection credentials or installation grants. Mirroring preserves upstream digest and provenance; a modified artifact is a new package identity.

## 13.11 Publication and installation lifecycle

```mermaid
sequenceDiagram
    participant Dev as Plugin author
    participant Reg as Quarantine registry
    participant Scan as Verifier and scanners
    participant Market as Marketplace
    participant Admin as Organization admin
    participant Inst as Installation service
    participant Sup as WorkerSupervisor
    participant GW as WorkerGateway
    participant Box as Plugin sandbox
    Dev->>Reg: push digest + SBOM + provenance + signature
    Reg->>Scan: verify, scan, conformance and behavior tests
    Scan-->>Market: immutable assessment for digest
    Market-->>Dev: publish or reject with stable findings
    Admin->>Inst: request install exact digest
    Inst->>Inst: resolve dependencies and policy; build plan
    Inst-->>Admin: permission, egress and risk diff
    Admin->>Inst: approve exact plan digest
    Inst->>Market: fetch and re-verify digest/proofs
    Inst->>Inst: write tenant installation lock and grants
    Sup->>Inst: materialize exact digest with policy epoch
    Inst-->>Sup: verified artifact + declared requirements
    Sup->>GW: request claim
    GW->>GW: claim DB; mint grant; persist hash/constraints
    GW-->>Sup: PoP/mTLS-bound ExecutionGrant
    Sup->>Box: start verified artifact with sanitized invocation
    Box->>Sup: opaque-handle host calls only
    Sup->>GW: gateway RPC + bound grant
    GW->>GW: validate, authorize operation, fenced result commit
```

Plugin upload, publication, organization installation, graph use, deployment, and execution are separate gates. Passing an earlier gate does not imply the later one.

## 13.12 Upgrade, rollback, and dependency impact

Upgrade planning lists:

- installed-to-target package and node-definition changes;
- transitive dependency and architecture changes;
- new/removed structured requirements, egress, secret slots, effect class, determinism, allowed adapter effect modes, schemas, limits, and UI extensions;
- every draft, published graph, deployment, and saved template referencing affected definitions;
- migration availability and contract-test results against authorized fixtures;
- canary environment and rollback compatibility.

Organization installation may hold multiple versions simultaneously so pinned graphs keep running. A quota bounds retained executable versions, but retention cannot evict a version still used by a deployment or unexpired execution history policy. Rollback changes future resolution/deployment only; it does not mutate an active execution.

## 13.13 Operational model

Required telemetry per package digest and tenant includes invocation rate, queue/run duration, cold starts, error codes, retries, timeouts, OOM/fuel, host-call rate/latency, network bytes/destinations, artifact bytes, log drops, capability denials, version adoption, and sandbox exits. Payloads and secret-derived values are not labels.

Circuit breakers operate per tenant, plugin digest, destination, and error class. A plugin failure cannot exhaust the global worker pool: separate concurrency pools, fair queues, resource quotas, and bulkheads isolate marketplace code. Platform operators can quarantine one digest and drain its warm hosts without restarting the control plane.

Support bundles contain manifest/digests, ABI/platform versions, redacted error summaries, resource telemetry, scan/provenance IDs, and invocation correlation IDs. They exclude graph inputs, resolved secrets, arbitrary logs, and artifacts unless an authorized user explicitly adds sanitized evidence.

## 13.14 Decisions and trade-offs

| Decision | Why | Alternative | Trade-off and failure mode |
|---|---|---|---|
| OCI artifact plus Wasm-first execution | Existing distribution primitives and strong portable capability boundary | Language package loaded in server | Build tooling is heavier; avoids control-plane compromise and dependency collision |
| Brokered capabilities instead of ambient OS access | Enforce per-invocation scope and produce audit facts | Give sandbox network/secret env vars | Proxy adds latency and adapter work; direct exfiltration and SSRF surface shrink substantially |
| Exact digest pinning | Reproducible graphs and rollback | Resolve semver/tag at run time | Multiple versions consume storage; avoids silent behavior changes |
| Install plan separate from publish | Tenant-specific permissions and policy cannot be approved by marketplace | Marketplace approval grants execution | More administrator steps; appropriate separation of publisher and tenant authority |
| Schema-derived UI plus isolated optional iframe | Most plugins need no executable browser code | Arbitrary React component in main app | Rich UI is constrained; XSS and dependency collision are contained |
| Dependency resolution at install/build only | Invocation cannot download mutable code | Runtime package installation | Bigger artifacts and slower builds; reliable cold starts and auditable SBOM |
| Tool registry approval after discovery | Protocol metadata is not authorization or semantic truth | Trust MCP/OpenAPI descriptions automatically | Manual/governed review for effects and labels; prevents self-granted tools |
| Retain revoked history but fence execution | Forensics and reproducibility | Delete revoked artifacts and metadata | Quarantine storage cost; historical evidence remains intelligible |

## 13.15 Patterns and anti-patterns

**Patterns:** Wasm component capability imports; digest-pinned OCI artifacts; reproducible builds; SBOM and provenance; gateway-minted and validated PoP/mTLS-bound attempt grants; opaque sandbox handles; host-mediated egress; schema-driven forms; config migrations with effect class and determinism `PURE`; staged canary upgrades; conformance and adversarial contract tests; transitive dependency “why” paths; revocation policy with explicit modes.

**Anti-patterns:** `curl | sh` installation; marketplace code in the API server or main browser origin; trusting a signature as proof of safety; wildcard egress; plaintext secrets in environment variables when broker use is possible; runtime package downloads; shared mutable language environments; tag-based execution; semver patch that adds permission/effect; plugin install hooks with database access; tool descriptions granting themselves authority; silently rediscovering and replacing an MCP schema.

## 13.16 Acceptance criteria

- An installed plugin can access only declared, approved, invocation-scoped host functions. Raw network, NATS, PostgreSQL, host filesystem, environment, Kubernetes API, the `ExecutionGrant`, secret material, and other tenants are unreachable from its sandbox.
- Replacing bytes behind a registry tag cannot change a graph, installation plan, worker materialization, or running execution pinned by digest.
- Adding required egress, secret use, capability, or effect class invalidates prior install approval and requires a major node version plus fresh graph review.
- Duplicate invocation, lease loss, cancellation, timeout, OOM/fuel exhaustion, broker denial, malformed output, and revoked digest all produce stable common node outcomes without crashing the host.
- Marketplace publication, organization installation, graph publication, deployment, and execution each independently verify the digest and applicable trust/policy state.
- MCP/OpenAPI rediscovery produces a drift candidate; it never mutates an approved ToolDefinition or silently changes an agent's available tools.
- Offline installation verifies signed metadata, provenance, dependencies, and expiry and clearly reports the age of its revocation snapshot.
