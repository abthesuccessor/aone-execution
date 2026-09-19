# 3. Graph Model and Shared State

## 3.1 Model boundary

The editable graph is authoring data. A mutable **DraftBranch** is committed as an immutable source **GraphVersion**. A **Compilation** is one compiler attempt against that GraphVersion; a successful attempt produces an immutable executable **CompiledPlan** whose typed Graph IR is its semantic payload. The runtime consumes only the CompiledPlan. This boundary prevents canvas layout, mutable package resolution, implicit coercions, or UI defaults from changing execution semantics.

~~~text
mutable DraftBranch
    -> commit immutable GraphVersion source
    -> create Compilation attempt
    -> normalize
    -> resolve namespaces/packages/plugins
    -> infer and check types
    -> validate control flow, scopes, effects, and policy
    -> lower sugar to core node/edge/loop/join constructs
    -> canonical serialize executable semantics
    -> create immutable CompiledPlan + signed envelope
    -> publish DeploymentRevision with environment-specific bindings/traffic
~~~

PostgreSQL is canonical for DraftBranch metadata, GraphVersion/Compilation/CompiledPlan manifests, resolved dependencies, deployments, and runtime state. Object storage holds their large content-addressed source/IR artifacts referenced by PostgreSQL. Search, graph-database, cache, and analytical views are rebuildable projections and never resolve version, authorization, or current state.

## 3.2 Core identities and invariants

| Object | Stable identity | Version behavior |
|---|---|---|
| Namespace | tenant id plus normalized hierarchical path | Mutable policy container; path rename creates an auditable alias |
| Graph | graph id | Mutable identity and metadata only |
| DraftBranch | branch id | Mutable CRDT/source lineage; never executable |
| GraphVersion | version id plus `source_hash` | Immutable GraphSpec source snapshot |
| Compilation | compilation id | Immutable attempt/result for one GraphVersion and compiler/toolchain configuration |
| CompiledPlan | plan id plus `plan_hash` | Immutable typed executable semantics and compatibility manifest |
| Node definition | logical node id within a GraphVersion | Identity persists across versions when semantically the same; runtime form is immutable in a CompiledPlan |
| Edge | logical edge id within a graph | Immutable in a GraphVersion/CompiledPlan |
| Package | tenant/registry/name | Versioned with immutable package versions |
| Plugin | publisher/name | Versioned, signed artifact and manifest |
| Template | template id | Immutable template revisions; instantiation records origin |
| DeploymentRevision | deployment id plus revision number | Immutable environment binding and weighted CompiledPlan selection |
| Execution | execution id | Pins exactly one GraphVersion/source hash, Compilation, selected CompiledPlan/plan and envelope hashes, dependency lock, policy snapshot, and deployment binding |
| Activation | deterministic activation id | Identifies one logical node occurrence including loop/expansion path |

The platform MUST enforce:

1. GraphVersions and CompiledPlans are independently content-addressed and immutable; Compilation results are append-only.
2. Node and edge ids are unique within a GraphVersion and do not encode display names.
3. Every data edge connects an output port to an input port with an assignable type.
4. Every control cycle crosses an explicit loop controller. Unstructured cycles are rejected.
5. Every variable read resolves to one declared scope and type.
6. Every CompiledPlan state rule declares path, allowed worker intent, persisted operation/conflict policy, and required capability; the worker supplies only the intent data.
7. Package and plugin references in a CompiledPlan are exact versions plus artifact digests; ranges exist only in GraphVersion source.
8. Node configurations contain secret references, never secret values.
9. Runtime values conform to the pinned schema before becoming visible downstream.
10. Layout, comments, selection, editor groups, source maps, diagnostics, and projection metadata do not affect `plan_hash`; executable configuration does. Presentation changes do affect `source_hash` when present in the committed GraphVersion source.

All entity IDs use UUIDv7 stored as UUIDs. Deterministic identities and content digests use domain-separated SHA-256. In particular, an `activation_id` or `effect_id` is a SHA-256 value, not a UUID/ULID.

## 3.3 Graph object model

### 3.3.1 Graph, GraphVersion, Compilation, and CompiledPlan

A graph is a namespaced, reusable executable interface:

- typed input and output ports;
- nodes, edges, variables, state schemas, and error outputs;
- budgets, resource defaults, permissions, and policy references;
- imports and a fully resolved dependency lock;
- semantic metadata such as owner, lifecycle, classification, tags, and labels;
- non-semantic authoring metadata such as layout and comments;
- GraphVersion parent(s) and source hash;
- Compilation provenance, compiler version, dependency lock, diagnostics, and status;
- CompiledPlan semantic plan hash, compatibility set, envelope hash, and signature.

A normal GraphVersion has one parent. A merge GraphVersion may have multiple source parents but contains one fully materialized source result; runtime never performs a merge. Multiple Compilation attempts may target the same GraphVersion, and distinct compiler/toolchain inputs may legitimately produce distinct CompiledPlans. An execution therefore pins all three identities rather than treating “graph revision” as an executable object.

### 3.3.2 Node

A node definition declares:

| Field | Meaning |
|---|---|
| logical_id | Stable source identity within the graph |
| kind | Core kind or namespaced plugin kind |
| implementation | Immutable implementation/package digest and entrypoint |
| inputs / outputs | Named, directed, typed ports |
| config | Schema-validated, non-secret configuration |
| effects | Declared external effect classes and idempotency capabilities |
| state_access | Read/write paths and conflict policies |
| resources | CPU, memory, accelerator, network class, isolation, placement |
| retry / timeout | Bounded runtime policy |
| determinism | PURE, RECORDED_NONDETERMINISTIC, or EFFECTFUL |
| cache_policy | Eligibility, key specification, TTL, and data classification |
| compensation | Optional compensation node/subgraph |
| labels / metadata | Search and governance attributes |

Node configuration is distinct from input. Configuration is pinned at publish time; input varies by activation.

### 3.3.3 Port

A port is a typed contract, not merely a connector dot. It defines:

- name and stable port id;
- direction: INPUT, OUTPUT, ERROR, SIGNAL_IN, or STREAM;
- JSON Schema or named type reference;
- cardinality: ONE, OPTIONAL, MANY, or STREAM;
- whether null is a value;
- default expression for an unconnected optional input;
- sensitivity/classification and maximum serialized size;
- stream ordering and delivery semantics where applicable.

Required input ports must be connected or bound by a graph input/constant. Multiple producers may feed a MANY port. Multiple producers may not feed ONE unless a merge node or explicit selection policy resolves them.

### 3.3.4 Edge and connector

An **edge** is semantic IR. A **connector** is the authoring/UI representation that may include handles and routing points. The compiler lowers connectors to edges.

Edge classes:

- DATA: transfers an immutable typed value reference;
- CONTROL: establishes readiness without a data payload;
- ERROR: routes a classified failure;
- SIGNAL: routes a durable external/internal signal;
- STREAM: transfers a sequence with explicit ordering and backpressure;
- COMPENSATION: activates only under declared compensation policy.

An edge may have a deterministic guard, projection expression, or bounded schema-safe coercion. Coercions are explicit IR operations; the runtime never guesses. An edge cannot invoke a model, tool, network call, or mutable lookup.

### 3.3.5 Variable, scope, context, and memory

A **variable** is a named, typed binding. Its declaration specifies mutability, initializer, scope, lifetime, storage class, visibility, and classification.

Scopes are lexical and hierarchical:

~~~text
tenant configuration (read-only to execution)
└── namespace configuration
    └── graph constants
        └── execution global state
            └── subgraph invocation state
                └── parallel branch state
                    └── loop state
                        └── iteration state
                            └── node attempt locals
~~~

Resolution chooses the nearest declaration; shadowing must be explicit. Parent state is not implicitly writable by children.

**Memory** is not one undifferentiated object:

- attempt scratch: ephemeral sandbox memory, never recoverable;
- node-local durable state: namespaced by activation or reusable component instance;
- execution state: versioned state shared inside one execution;
- conversation/session memory: an external versioned resource referenced by id;
- tenant knowledge/memory: governed records outside the execution, accessed through authorized nodes;
- cache: disposable derived data, never canonical memory.

Graph context exposes references to these resources but does not merge them into a single mutable dictionary.

### 3.3.6 Metadata, tags, and labels

Metadata is typed governance data: owner, description, data classification, risk class, lifecycle, created-by, timestamps, and source lineage. **Tags** are searchable user vocabulary. **Labels** are key/value selectors used by policy and placement. Reserved label prefixes are platform-controlled; for example system.*, security.*, and placement.* cannot be set by an ordinary editor.

Metadata affecting execution policy participates in `plan_hash`. Pure presentation fields participate only in the committed GraphVersion `source_hash`.

### 3.3.7 Reuse: components, subgraphs, templates, packages, and plugins

| Mechanism | Contract | Resolution |
|---|---|---|
| Reusable component | Node or small graph with typed interface | Exact component GraphVersion and compiled digest |
| Subgraph | Graph callable inline or as child execution | Exact CompiledPlan after deployment resolution |
| Template | Copy-time scaffolding | Records template GraphVersion but evolves independently |
| Package | Versioned bundle of graphs, types, prompts, tests, and assets | SemVer range in source; exact digest in lock |
| Plugin | Signed executable extension plus node schemas and permissions | Exact version, platform ABI, digest, publisher trust |

Package resolution occurs during Compilation. A lock includes transitive versions, digests, registries, signatures, licenses, runtime ABI, and revocation status. A deployment can refuse a CompiledPlan if a dependency is later revoked; it cannot silently substitute a newer dependency.

## 3.4 CompiledPlan and typed Graph IR

### 3.4.1 Canonical CompiledPlan document

The following schema shows the signed CompiledPlan envelope and executable core. The GraphVersion source artifact is separate. Node-kind-specific configuration schemas are referenced from the resolved dependency lock. The `plan_hash` is calculated over the executable projection defined in Section 3.7, not over its own field or the surrounding signature envelope. Effect fields retain the canonical GraphSpec camelCase vocabulary; compilation adds only the resolved effect name, idempotency mode, and capability requirements.

~~~json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:ege:compiled-plan-envelope:v1",
  "title": "CompiledPlan envelope and typed Graph IR",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "plan_format_version", "graph", "graph_version", "compilation", "plan",
    "interface", "types", "variables", "nodes", "edges", "loops",
    "imports", "policies"
  ],
  "properties": {
    "plan_format_version": {"const": "1.0"},
    "graph": {
      "type": "object",
      "additionalProperties": false,
      "required": ["id", "tenant_id", "namespace", "name"],
      "properties": {
        "id": {"$ref": "#/$defs/uuidv7"},
        "tenant_id": {"$ref": "#/$defs/uuidv7"},
        "namespace": {
          "type": "string",
          "pattern": "^[a-z0-9][a-z0-9._/-]{0,254}$"
        },
        "name": {"type": "string", "minLength": 1, "maxLength": 128},
        "labels": {
          "type": "object",
          "additionalProperties": {"type": "string", "maxLength": 256}
        }
      }
    },
    "graph_version": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "id", "number", "source_hash", "created_at"
      ],
      "properties": {
        "id": {"$ref": "#/$defs/uuidv7"},
        "number": {"type": "integer", "minimum": 1},
        "source_hash": {"$ref": "#/$defs/hash"},
        "created_at": {"type": "string", "format": "date-time"},
        "parent_graph_version_ids": {
          "type": "array",
          "items": {"$ref": "#/$defs/uuidv7"},
          "uniqueItems": true
        }
      }
    },
    "compilation": {
      "type": "object",
      "additionalProperties": false,
      "required": ["id", "compiler_version", "dependency_lock_hash"],
      "properties": {
        "id": {"$ref": "#/$defs/uuidv7"},
        "compiler_version": {"type": "string"},
        "dependency_lock_hash": {"$ref": "#/$defs/hash"}
      }
    },
    "plan": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "id", "plan_hash", "envelope_hash",
        "worker_compatibility_set", "created_at"
      ],
      "properties": {
        "id": {"$ref": "#/$defs/uuidv7"},
        "plan_hash": {"$ref": "#/$defs/hash"},
        "envelope_hash": {"$ref": "#/$defs/hash"},
        "worker_compatibility_set": {
          "type": "array",
          "items": {"type": "string"},
          "minItems": 1,
          "uniqueItems": true
        },
        "created_at": {"type": "string", "format": "date-time"},
        "signature_key_id": {"type": ["string", "null"]},
        "signature": {"type": ["string", "null"]}
      }
    },
    "interface": {
      "type": "object",
      "additionalProperties": false,
      "required": ["inputs", "outputs", "errors"],
      "properties": {
        "inputs": {"type": "array", "items": {"$ref": "#/$defs/port"}},
        "outputs": {"type": "array", "items": {"$ref": "#/$defs/port"}},
        "errors": {"type": "array", "items": {"$ref": "#/$defs/port"}}
      }
    },
    "types": {
      "type": "object",
      "additionalProperties": {
        "type": "object",
        "description": "JSON Schema 2020-12 document"
      }
    },
    "variables": {
      "type": "array",
      "items": {"$ref": "#/$defs/variable"}
    },
    "nodes": {
      "type": "array",
      "items": {"$ref": "#/$defs/node"}
    },
    "edges": {
      "type": "array",
      "items": {"$ref": "#/$defs/edge"}
    },
    "loops": {
      "type": "array",
      "items": {"$ref": "#/$defs/loop"}
    },
    "imports": {
      "type": "array",
      "items": {"$ref": "#/$defs/import"}
    },
    "policies": {
      "type": "object",
      "additionalProperties": false,
      "required": ["budget", "default_timeout", "capabilities"],
      "properties": {
        "budget": {"$ref": "#/$defs/executionBudget"},
        "default_timeout": {"type": "string", "format": "duration"},
        "capabilities": {
          "type": "array",
          "items": {"$ref": "#/$defs/capabilityRequirement"},
          "uniqueItems": true
        },
        "state_schema_ref": {"type": "string"},
        "retention_policy_ref": {"type": "string"}
      }
    }
  },
  "$defs": {
    "uuidv7": {
      "type": "string",
      "format": "uuid",
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    },
    "hash": {
      "type": "string",
      "pattern": "^sha256:[0-9a-f]{64}$"
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
            "version_digest": {"$ref": "#/$defs/hash"}
          }
        },
        "constraints": {"type": "object", "maxProperties": 64}
      }
    },
    "endpoint": {
      "type": "object",
      "additionalProperties": false,
      "required": ["node", "port"],
      "properties": {
        "node": {"type": "string"},
        "port": {"type": "string"}
      }
    },
    "port": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "id", "name", "direction", "type_ref", "cardinality", "classification"
      ],
      "properties": {
        "id": {"type": "string", "pattern": "^[A-Za-z][A-Za-z0-9_-]{0,63}$"},
        "name": {"type": "string", "minLength": 1, "maxLength": 128},
        "direction": {
          "enum": ["INPUT", "OUTPUT", "ERROR", "SIGNAL_IN", "STREAM"]
        },
        "type_ref": {"type": "string"},
        "cardinality": {"enum": ["ONE", "OPTIONAL", "MANY", "STREAM"]},
        "nullable": {"type": "boolean", "default": false},
        "max_bytes": {"type": "integer", "minimum": 0},
        "classification": {"enum": ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED"]}
      }
    },
    "variable": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "id", "name", "type_ref", "scope", "mutability",
        "storage", "classification"
      ],
      "properties": {
        "id": {"type": "string"},
        "name": {"type": "string"},
        "type_ref": {"type": "string"},
        "scope": {
          "enum": [
            "GRAPH_CONSTANT", "EXECUTION", "SUBGRAPH", "BRANCH",
            "LOOP", "ITERATION", "NODE"
          ]
        },
        "mutability": {"enum": ["IMMUTABLE", "SINGLE_ASSIGNMENT", "COMPARE_AND_SET", "REDUCER"]},
        "storage": {"enum": ["INLINE", "ARTIFACT_REF", "EXTERNAL_REF"]},
        "initializer": {},
        "classification": {"enum": ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED"]},
        "conflict_policy": {
          "enum": ["FAIL_CONFLICT", "RECOMPUTE", "APPLY_REDUCER", "SERIALIZE_SCOPE"]
        }
      }
    },
    "stateAccess": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "path", "mode", "allowed_worker_operations", "mutability",
        "conflict_policy", "classification", "capability_requirement"
      ],
      "properties": {
        "path": {
          "type": "string",
          "pattern": "^/(?:[^/~]|~[01])*(?:/(?:[^/~]|~[01])*)*$",
          "maxLength": 2048
        },
        "mode": {"enum": ["READ", "WRITE", "REDUCE"]},
        "allowed_worker_operations": {
          "type": "array",
          "uniqueItems": true,
          "maxItems": 3,
          "items": {
            "enum": [
              "OPERATION_PUT", "OPERATION_DELETE", "OPERATION_REDUCE",
              "OPERATION_BIND_ARTIFACT", "OPERATION_CLOSE_SCOPE"
            ]
          }
        },
        "mutability": {
          "enum": ["IMMUTABLE", "SINGLE_ASSIGNMENT", "COMPARE_AND_SET", "REDUCER"]
        },
        "conflict_policy": {
          "enum": ["FAIL_CONFLICT", "RECOMPUTE", "APPLY_REDUCER", "SERIALIZE_SCOPE"]
        },
        "reducer_digest": {"$ref": "#/$defs/hash"},
        "classification": {"enum": ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED"]},
        "capability_requirement": {"$ref": "#/$defs/capabilityRequirement"}
      },
      "oneOf": [
        {
          "title": "Read-only state access",
          "properties": {
            "mode": {"const": "READ"},
            "allowed_worker_operations": {"type": "array", "maxItems": 0}
          },
          "oneOf": [
            {
              "properties": {
                "mutability": {"enum": ["IMMUTABLE", "SINGLE_ASSIGNMENT"]},
                "conflict_policy": {"const": "FAIL_CONFLICT"},
                "reducer_digest": false
              }
            },
            {
              "properties": {
                "mutability": {"const": "COMPARE_AND_SET"},
                "conflict_policy": {"enum": ["FAIL_CONFLICT", "RECOMPUTE", "SERIALIZE_SCOPE"]},
                "reducer_digest": false
              }
            },
            {
              "properties": {
                "mutability": {"const": "REDUCER"},
                "conflict_policy": {"const": "APPLY_REDUCER"},
                "reducer_digest": {"$ref": "#/$defs/hash"}
              },
              "required": ["reducer_digest"]
            }
          ]
        },
        {
          "title": "Ordinary or scope-control state write",
          "properties": {"mode": {"const": "WRITE"}},
          "oneOf": [
            {
              "properties": {
                "mutability": {"const": "IMMUTABLE"},
                "conflict_policy": {"const": "FAIL_CONFLICT"},
                "reducer_digest": false,
                "allowed_worker_operations": {
                  "type": "array",
                  "items": {"enum": ["OPERATION_PUT", "OPERATION_CLOSE_SCOPE"]},
                  "minItems": 1,
                  "maxItems": 1,
                  "uniqueItems": true
                }
              }
            },
            {
              "properties": {
                "mutability": {"const": "SINGLE_ASSIGNMENT"},
                "conflict_policy": {"const": "FAIL_CONFLICT"},
                "reducer_digest": false,
                "allowed_worker_operations": {
                  "type": "array",
                  "items": {"enum": ["OPERATION_PUT", "OPERATION_BIND_ARTIFACT"]},
                  "minItems": 1,
                  "maxItems": 2,
                  "uniqueItems": true
                }
              }
            },
            {
              "properties": {
                "mutability": {"const": "COMPARE_AND_SET"},
                "conflict_policy": {"enum": ["FAIL_CONFLICT", "RECOMPUTE", "SERIALIZE_SCOPE"]},
                "reducer_digest": false,
                "allowed_worker_operations": {
                  "type": "array",
                  "items": {
                    "enum": ["OPERATION_PUT", "OPERATION_DELETE", "OPERATION_BIND_ARTIFACT"]
                  },
                  "minItems": 1,
                  "maxItems": 3,
                  "uniqueItems": true
                }
              }
            }
          ]
        },
        {
          "title": "Reducer state access",
          "properties": {
            "mode": {"const": "REDUCE"},
            "mutability": {"const": "REDUCER"},
            "conflict_policy": {"const": "APPLY_REDUCER"},
            "reducer_digest": {"$ref": "#/$defs/hash"},
            "allowed_worker_operations": {
              "type": "array",
              "prefixItems": [{"const": "OPERATION_REDUCE"}],
              "items": false,
              "minItems": 1,
              "maxItems": 1
            }
          },
          "required": ["reducer_digest"]
        }
      ]
    },
    "node": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "id", "kind", "implementation", "inputs", "outputs",
        "config", "state_access", "effects", "determinism", "resources",
        "timeout", "retry"
      ],
      "properties": {
        "id": {"type": "string", "pattern": "^[A-Za-z][A-Za-z0-9_-]{0,127}$"},
        "kind": {"type": "string"},
        "implementation": {
          "type": "object",
          "required": ["package", "entrypoint", "digest"],
          "properties": {
            "package": {"type": "string"},
            "entrypoint": {"type": "string"},
            "digest": {"$ref": "#/$defs/hash"}
          },
          "additionalProperties": false
        },
        "inputs": {"type": "array", "items": {"$ref": "#/$defs/port"}},
        "outputs": {"type": "array", "items": {"$ref": "#/$defs/port"}},
        "config": {"type": "object"},
        "state_access": {
          "type": "array",
          "items": {"$ref": "#/$defs/stateAccess"},
          "maxItems": 1024
        },
        "effects": {
          "type": "array",
          "items": {"$ref": "#/$defs/compiledEffect"},
          "maxItems": 128
        },
        "determinism": {
          "enum": ["PURE", "RECORDED_NONDETERMINISTIC", "EFFECTFUL"]
        },
        "resources": {"$ref": "#/$defs/resourceEnvelope"},
        "timeout": {"$ref": "#/$defs/nodeTimeout"},
        "retry": {"$ref": "#/$defs/retryPolicy"},
        "cache_policy": {
          "oneOf": [
            {"$ref": "#/$defs/cachePolicy"},
            {"type": "null"}
          ]
        },
        "labels": {"type": "object"}
      },
      "allOf": [
        {
          "if": {
            "properties": {"cache_policy": {"type": "object"}},
            "required": ["cache_policy"]
          },
          "then": {
            "properties": {
              "determinism": {"enum": ["PURE", "RECORDED_NONDETERMINISTIC"]},
              "effects": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {"class": {"enum": ["PURE", "READ_ONLY"]}}
                }
              }
            }
          }
        }
      ]
    },
    "resourceEnvelope": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "class", "cpu_millis", "memory_mib", "ephemeral_storage_mib",
        "gpu_count", "network"
      ],
      "properties": {
        "class": {
          "type": "string",
          "pattern": "^[a-z][a-z0-9._-]{0,127}$"
        },
        "cpu_millis": {"type": "integer", "minimum": 1, "maximum": 128000},
        "memory_mib": {"type": "integer", "minimum": 16, "maximum": 1048576},
        "ephemeral_storage_mib": {"type": "integer", "minimum": 0, "maximum": 1048576},
        "gpu_count": {"type": "integer", "minimum": 0, "maximum": 64},
        "network": {"enum": ["NONE", "BROKERED_CAPABILITIES_ONLY"]}
      }
    },
    "nodeTimeout": {
      "type": "object",
      "additionalProperties": false,
      "required": ["attempt", "heartbeat_interval", "cancellation_grace"],
      "properties": {
        "attempt": {"type": "string", "format": "duration"},
        "heartbeat_interval": {"type": "string", "format": "duration"},
        "cancellation_grace": {"type": "string", "format": "duration"}
      }
    },
    "retryPolicy": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "max_attempts", "backoff", "initial_delay", "max_delay", "jitter",
        "categories", "ambiguous_effect"
      ],
      "properties": {
        "max_attempts": {"type": "integer", "minimum": 1, "maximum": 100},
        "backoff": {"enum": ["FIXED", "LINEAR", "EXPONENTIAL", "DECORRELATED_JITTER"]},
        "initial_delay": {"type": "string", "format": "duration"},
        "max_delay": {"type": "string", "format": "duration"},
        "jitter": {"const": "DETERMINISTIC"},
        "categories": {
          "type": "array",
          "uniqueItems": true,
          "maxItems": 7,
          "items": {
            "enum": [
              "RUNTIME_ERROR_CATEGORY_USER", "RUNTIME_ERROR_CATEGORY_TRANSIENT",
              "RUNTIME_ERROR_CATEGORY_PROVIDER", "RUNTIME_ERROR_CATEGORY_POLICY",
              "RUNTIME_ERROR_CATEGORY_RESOURCE", "RUNTIME_ERROR_CATEGORY_BUG",
              "RUNTIME_ERROR_CATEGORY_CANCELLED"
            ]
          }
        },
        "ambiguous_effect": {"const": "RECONCILE_REQUIRED"}
      }
    },
    "executionBudget": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "max_duration", "max_cost_microunits", "max_model_tokens",
        "max_tool_calls", "max_child_activations", "max_parallelism",
        "max_state_bytes"
      ],
      "properties": {
        "max_duration": {"type": "string", "format": "duration"},
        "max_cost_microunits": {"type": "integer", "minimum": 0},
        "max_model_tokens": {"type": "integer", "minimum": 0},
        "max_tool_calls": {"type": "integer", "minimum": 0},
        "max_child_activations": {"type": "integer", "minimum": 0},
        "max_parallelism": {"type": "integer", "minimum": 1},
        "max_state_bytes": {"type": "integer", "minimum": 0}
      }
    },
    "loopBudget": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "max_iterations", "max_elapsed_ms", "max_cost_microunits",
        "max_model_tokens", "max_tool_calls", "max_child_activations",
        "max_parallel_candidates", "max_retry_attempts_inside_loop"
      ],
      "properties": {
        "max_iterations": {"type": "integer", "minimum": 1},
        "max_elapsed_ms": {"type": "integer", "minimum": 1},
        "max_cost_microunits": {"type": "integer", "minimum": 0},
        "max_model_tokens": {"type": "integer", "minimum": 0},
        "max_tool_calls": {"type": "integer", "minimum": 0},
        "max_child_activations": {"type": "integer", "minimum": 1},
        "max_parallel_candidates": {"type": "integer", "minimum": 1},
        "max_retry_attempts_inside_loop": {"type": "integer", "minimum": 0}
      }
    },
    "loopStop": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "success_expression_digest", "evaluator_set_hash",
        "minimum_iterations", "patience", "minimum_improvement"
      ],
      "properties": {
        "success_expression_digest": {"$ref": "#/$defs/hash"},
        "evaluator_set_hash": {"$ref": "#/$defs/hash"},
        "minimum_iterations": {"type": "integer", "minimum": 0},
        "patience": {"type": "integer", "minimum": 0},
        "minimum_improvement": {"type": "number", "minimum": 0}
      }
    },
    "expressionRef": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "engine", "bytecode_artifact_id", "bytecode_digest", "result_type_ref"
      ],
      "properties": {
        "engine": {"const": "EGE_EXPR_V1"},
        "bytecode_artifact_id": {"$ref": "#/$defs/uuidv7"},
        "bytecode_digest": {"$ref": "#/$defs/hash"},
        "result_type_ref": {"type": "string", "minLength": 1, "maxLength": 1024}
      }
    },
    "cachePolicy": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "key", "scope", "ttl", "max_entry_bytes", "classification",
        "include_policy_snapshot_hash", "include_implementation_digest"
      ],
      "properties": {
        "key": {"$ref": "#/$defs/expressionRef"},
        "scope": {"enum": ["EXECUTION", "TENANT", "GLOBAL_PUBLIC"]},
        "ttl": {"type": "string", "format": "duration"},
        "max_entry_bytes": {"type": "integer", "minimum": 1},
        "classification": {"enum": ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED"]},
        "include_policy_snapshot_hash": {"const": true},
        "include_implementation_digest": {"const": true}
      },
      "allOf": [
        {
          "if": {
            "properties": {"scope": {"const": "GLOBAL_PUBLIC"}},
            "required": ["scope"]
          },
          "then": {
            "properties": {"classification": {"const": "PUBLIC"}}
          }
        }
      ]
    },
    "edgeBuffer": {
      "type": "object",
      "additionalProperties": false,
      "required": ["capacity", "overflow", "delivery"],
      "properties": {
        "capacity": {"type": "integer", "minimum": 1, "maximum": 1000000},
        "overflow": {"enum": ["BLOCK", "DROP_OLDEST", "DROP_NEWEST", "FAIL"]},
        "delivery": {"enum": ["AT_LEAST_ONCE", "LATEST_ONLY"]}
      }
    },
    "compiledEffect": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "name", "class", "deliveryContract", "allowedAdapterEffectModes",
        "idempotencyMode", "capabilityRequirements"
      ],
      "properties": {
        "name": {
          "type": "string",
          "pattern": "^[A-Za-z][A-Za-z0-9_-]{0,127}$"
        },
        "class": {
          "enum": [
            "PURE", "READ_ONLY", "IDEMPOTENT_WRITE", "COMPENSATABLE_WRITE",
            "NON_IDEMPOTENT_WRITE", "HUMAN_EFFECT"
          ]
        },
        "deliveryContract": {
          "enum": [
            "NO_EFFECT", "READ_ONLY_REPEATABLE", "DESTINATION_IDEMPOTENCY",
            "TRANSACTIONAL_ADAPTER", "COMPENSATE_ON_FAILURE",
            "AT_LEAST_ONCE_REPEATABLE", "STOP_ON_AMBIGUITY"
          ]
        },
        "allowedAdapterEffectModes": {
          "type": "array",
          "minItems": 1,
          "maxItems": 3,
          "uniqueItems": true,
          "items": {
            "enum": [
              "SUBSTITUTE_RECORDED", "REEXECUTE_READ_ONLY",
              "REEXECUTE_AUTHORIZED_EFFECT", "FORBID"
            ]
          }
        },
        "idempotencyMode": {"enum": ["NATIVE", "ADAPTER", "NONE"]},
        "idempotencyKey": {"type": "string", "minLength": 1, "maxLength": 4096},
        "compensationPort": {
          "type": "string",
          "pattern": "^[A-Za-z][A-Za-z0-9_-]{0,63}$"
        },
        "reconciliationProcedure": {
          "type": "string",
          "minLength": 1,
          "maxLength": 4096
        },
        "approvalPolicy": {
          "type": "string",
          "minLength": 1,
          "maxLength": 1024
        },
        "capabilityRequirements": {
          "type": "array",
          "items": {"$ref": "#/$defs/capabilityRequirement"},
          "uniqueItems": true,
          "maxItems": 128
        }
      },
      "allOf": [
        {
          "if": {"properties": {"class": {"const": "PURE"}}, "required": ["class"]},
          "then": {
            "properties": {
              "deliveryContract": {"const": "NO_EFFECT"},
              "allowedAdapterEffectModes": {
                "type": "array", "items": {"const": "FORBID"},
                "minItems": 1, "maxItems": 1, "uniqueItems": true
              },
              "idempotencyMode": {"const": "NONE"},
              "idempotencyKey": false,
              "compensationPort": false,
              "reconciliationProcedure": false,
              "approvalPolicy": false
            }
          }
        },
        {
          "if": {"properties": {"class": {"const": "READ_ONLY"}}, "required": ["class"]},
          "then": {
            "properties": {
              "deliveryContract": {"const": "READ_ONLY_REPEATABLE"},
              "allowedAdapterEffectModes": {
                "type": "array",
                "items": {"enum": ["SUBSTITUTE_RECORDED", "REEXECUTE_READ_ONLY", "FORBID"]},
                "minItems": 1, "maxItems": 3, "uniqueItems": true
              },
              "idempotencyMode": {"const": "NONE"},
              "idempotencyKey": false,
              "compensationPort": false,
              "reconciliationProcedure": false,
              "approvalPolicy": false
            }
          }
        },
        {
          "if": {"properties": {"class": {"const": "IDEMPOTENT_WRITE"}}, "required": ["class"]},
          "then": {
            "required": ["idempotencyKey", "reconciliationProcedure"],
            "properties": {
              "deliveryContract": {"enum": ["DESTINATION_IDEMPOTENCY", "TRANSACTIONAL_ADAPTER"]},
              "allowedAdapterEffectModes": {
                "type": "array",
                "items": {"enum": ["SUBSTITUTE_RECORDED", "REEXECUTE_AUTHORIZED_EFFECT", "FORBID"]},
                "minItems": 1, "maxItems": 3, "uniqueItems": true
              },
              "idempotencyMode": {"enum": ["NATIVE", "ADAPTER"]},
              "compensationPort": false,
              "approvalPolicy": false
            }
          }
        },
        {
          "if": {"properties": {"class": {"const": "COMPENSATABLE_WRITE"}}, "required": ["class"]},
          "then": {
            "required": ["idempotencyKey", "compensationPort", "reconciliationProcedure"],
            "properties": {
              "deliveryContract": {"const": "COMPENSATE_ON_FAILURE"},
              "allowedAdapterEffectModes": {
                "type": "array",
                "items": {"enum": ["SUBSTITUTE_RECORDED", "REEXECUTE_AUTHORIZED_EFFECT", "FORBID"]},
                "minItems": 1, "maxItems": 3, "uniqueItems": true
              },
              "idempotencyMode": {"enum": ["NATIVE", "ADAPTER"]},
              "approvalPolicy": false
            }
          }
        },
        {
          "if": {"properties": {"class": {"const": "NON_IDEMPOTENT_WRITE"}}, "required": ["class"]},
          "then": {
            "required": ["reconciliationProcedure"],
            "properties": {
              "deliveryContract": {"enum": ["AT_LEAST_ONCE_REPEATABLE", "STOP_ON_AMBIGUITY"]},
              "allowedAdapterEffectModes": {
                "type": "array",
                "items": {"enum": ["SUBSTITUTE_RECORDED", "REEXECUTE_AUTHORIZED_EFFECT", "FORBID"]},
                "minItems": 1, "maxItems": 3, "uniqueItems": true
              },
              "idempotencyMode": {"const": "NONE"},
              "idempotencyKey": false,
              "compensationPort": false,
              "approvalPolicy": false
            }
          }
        },
        {
          "if": {"properties": {"class": {"const": "HUMAN_EFFECT"}}, "required": ["class"]},
          "then": {
            "required": ["approvalPolicy", "reconciliationProcedure"],
            "properties": {
              "deliveryContract": {"const": "STOP_ON_AMBIGUITY"},
              "allowedAdapterEffectModes": {
                "type": "array",
                "items": {"enum": ["SUBSTITUTE_RECORDED", "REEXECUTE_AUTHORIZED_EFFECT", "FORBID"]},
                "minItems": 1, "maxItems": 3, "uniqueItems": true
              },
              "idempotencyMode": {"const": "NONE"},
              "idempotencyKey": false,
              "compensationPort": false
            }
          }
        }
      ]
    },
    "edge": {
      "type": "object",
      "additionalProperties": false,
      "required": ["id", "kind", "from", "to"],
      "properties": {
        "id": {"type": "string"},
        "kind": {
          "enum": ["DATA", "CONTROL", "ERROR", "SIGNAL", "STREAM", "COMPENSATION"]
        },
        "from": {"$ref": "#/$defs/endpoint"},
        "to": {"$ref": "#/$defs/endpoint"},
        "guard": {
          "oneOf": [
            {"$ref": "#/$defs/expressionRef"},
            {"type": "null"}
          ]
        },
        "projection": {
          "oneOf": [
            {"$ref": "#/$defs/expressionRef"},
            {"type": "null"}
          ]
        },
        "buffer": {
          "oneOf": [
            {"$ref": "#/$defs/edgeBuffer"},
            {"type": "null"}
          ]
        },
        "on_type_error": {"enum": ["FAIL", "ROUTE_ERROR"]}
      }
    },
    "loop": {
      "type": "object",
      "additionalProperties": false,
      "required": ["id", "controller_node", "body_nodes", "budgets", "stop"],
      "properties": {
        "id": {"type": "string"},
        "controller_node": {"type": "string"},
        "body_nodes": {
          "type": "array",
          "items": {"type": "string"},
          "minItems": 1,
          "uniqueItems": true
        },
        "budgets": {"$ref": "#/$defs/loopBudget"},
        "stop": {"$ref": "#/$defs/loopStop"}
      }
    },
    "import": {
      "type": "object",
      "additionalProperties": false,
      "required": ["package", "version", "digest", "registry"],
      "properties": {
        "package": {"type": "string"},
        "version": {"type": "string"},
        "digest": {"$ref": "#/$defs/hash"},
        "registry": {"type": "string"},
        "signature_key_id": {"type": ["string", "null"]}
      }
    }
  }
}
~~~

The compiler additionally enforces cross-object constraints JSON Schema cannot express: uniqueness, reference existence, port assignability, scope legality, cycle structure, resource limits, policy compatibility, and complete package resolution. A normalized JSON Pointer is bounded to 2,048 Unicode code points, and one node may receive at most 1,024 writable path rules; those exact bounds are repeated in GraphSpec, CompiledPlan, runtime lease, sandbox projection, persisted delta, and gateway validation. The capability `resource.id` is a bounded opaque policy-rule identifier, not the path; the normalized path and its digest are compiler-owned constraints so the 768-character resource-ID bound does not truncate state authority.

### 3.4.2 Example lowered IR

~~~yaml
plan_format_version: "1.0"
graph:
  id: 019fd4b4-8615-7b21-aefe-065972387fd6
  tenant_id: 019fd4b4-2031-7e4b-914c-83d9b2ebd146
  namespace: claims/production
  name: assess-claim
  labels:
    security.risk: high
graph_version:
  id: 019fd4b5-2b68-78e7-bd34-38ce4320ac41
  number: 17
  source_hash: sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  created_at: 2026-08-06T06:00:00Z
compilation:
  id: 019fd4b5-5bc9-7e61-8559-abf7a5d9ac32
  compiler_version: 1.8.2
  dependency_lock_hash: sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
plan:
  id: 019fd4b5-8318-7b61-b879-d54a8bc6f477
  plan_hash: sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee
  envelope_hash: sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff
  worker_compatibility_set: [rust-runtime-v1, wasm-component-v1]
  created_at: 2026-08-06T06:00:00Z
interface:
  inputs:
    - {id: claim, name: claim, direction: INPUT, type_ref: "#/types/Claim", cardinality: ONE, classification: CONFIDENTIAL}
  outputs:
    - {id: decision, name: decision, direction: OUTPUT, type_ref: "#/types/Decision", cardinality: ONE, classification: CONFIDENTIAL}
  errors: []
types:
  Claim:
    type: object
    required: [claim_id, amount]
    properties:
      claim_id: {type: string}
      amount: {type: number, minimum: 0}
  Decision:
    type: object
    required: [route, score]
    properties:
      route: {enum: [auto, manual]}
      score: {type: number, minimum: 0, maximum: 1}
variables:
  - id: assessment
    name: assessment
    type_ref: "#/types/Decision"
    scope: EXECUTION
    mutability: COMPARE_AND_SET
    storage: INLINE
    classification: CONFIDENTIAL
    conflict_policy: FAIL_CONFLICT
nodes:
  - id: score
    kind: core.function
    implementation:
      package: platform/scoring
      entrypoint: score_claim
      digest: sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
    inputs:
      - {id: claim, name: claim, direction: INPUT, type_ref: "#/types/Claim", cardinality: ONE, classification: CONFIDENTIAL}
    outputs:
      - {id: decision, name: decision, direction: OUTPUT, type_ref: "#/types/Decision", cardinality: ONE, classification: CONFIDENTIAL}
    config: {}
    state_access:
      - path: /assessment
        mode: WRITE
        allowed_worker_operations: [OPERATION_PUT]
        mutability: COMPARE_AND_SET
        conflict_policy: FAIL_CONFLICT
        classification: CONFIDENTIAL
        capability_requirement:
          action: state.write
          resource: {kind: state_path, id: state-rule/assessment}
          constraints: {path: /assessment}
    effects: []
    determinism: PURE
    resources:
      class: cpu-small
      cpu_millis: 250
      memory_mib: 256
      ephemeral_storage_mib: 512
      gpu_count: 0
      network: NONE
    timeout: {attempt: PT5S, heartbeat_interval: PT1S, cancellation_grace: PT3S}
    retry:
      max_attempts: 2
      backoff: EXPONENTIAL
      initial_delay: PT1S
      max_delay: PT5S
      jitter: DETERMINISTIC
      categories: [RUNTIME_ERROR_CATEGORY_TRANSIENT]
      ambiguous_effect: RECONCILE_REQUIRED
edges: []
loops: []
imports:
  - package: platform/scoring
    version: 3.2.1
    digest: sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd
    registry: internal
policies:
  budget:
    max_duration: PT30S
    max_cost_microunits: 10000
    max_model_tokens: 0
    max_tool_calls: 0
    max_child_activations: 0
    max_parallelism: 1
    max_state_bytes: 1048576
  default_timeout: PT10S
  capabilities: []
  state_schema_ref: "#/types/ExecutionState"
~~~

## 3.5 Compiler pipeline

### 3.5.1 Passes

1. Parse the source format and preserve source locations.
2. Normalize ids, defaults, expressions, and editor-only metadata.
3. Resolve namespace references and package ranges against allowed registries.
4. Load signed manifests and node-kind configuration schemas.
5. Build type and scope environments.
6. Validate node configuration and graph interface.
7. Type-check edges, projections, variable access, and state paths.
8. Build control-flow regions; reject irreducible/uncontrolled cycles.
9. Lower switch, fork, merge, subgraph, map, loop, and error sugar.
10. Calculate effect, permission, data-flow, and resource summaries.
11. Check budgets, recursion/expansion bounds, and policy.
12. Canonicalize the executable projection, calculate `plan_hash`, construct/sign the envelope, and persist the successful Compilation plus immutable CompiledPlan and dependency lock.

Every compiler invocation first creates a UUIDv7 Compilation record. Compiler diagnostics include source location, stable code, severity, related objects, remediation, and whether the issue blocks publishing. Failed attempts retain diagnostics but produce no CompiledPlan. Runtime does not “fix” an invalid GraphVersion.

The node determinism declaration (`PURE`, `RECORDED_NONDETERMINISTIC`, or `EFFECTFUL`) is compile-time semantics, not a replay mode. Runtime uses the orthogonal Chapter 2 taxonomy: replay `operation` is `STATE_REBUILD`, `EXACT_REPLAY`, or `FORKED_REPLAY`; `execution_mode` is `LIVE`, `REPLAY`, or `SIMULATION`; adapter `effect_mode` is `SUBSTITUTE_RECORDED`, `REEXECUTE_READ_ONLY`, `REEXECUTE_AUTHORIZED_EFFECT`, or `FORBID`. A CompiledPlan may constrain allowed combinations but may not redefine these enum values.

### 3.5.2 Type compatibility

Type assignability follows JSON Schema structure plus platform restrictions:

- a producer must satisfy every consumer-required property;
- numeric narrowing needs an explicit checked conversion;
- additionalProperties from an open producer cannot flow into a closed consumer without projection;
- nullable is distinct from optional;
- MANY to ONE requires an explicit selector/reducer;
- STREAM to materialized input requires an explicit bounded collect node;
- data classification may only stay equal or become more restrictive unless a declassification policy node authorizes it.

Schema evolution is backward compatible only when old producers remain assignable to new consumers for graph input, and new outputs remain assignable to old consumers for graph output. The publish API reports input, output, state, and event compatibility separately.

## 3.6 Execution state architecture

### 3.6.1 State layers

~~~mermaid
flowchart TB
    C["Immutable execution context\npins, identity, budgets"] --> S["Snapshot at state version V"]
    S --> G["Global execution state"]
    S --> SG["Subgraph scope"]
    S --> B["Branch scope"]
    S --> L["Loop / iteration scope"]
    S --> N["Node-local durable scope"]
    G & SG & B & L & N --> W["Typed write intents"]
    W --> MVCC["MVCC validator + conflict policy"]
    MVCC --> D["State delta V -> V+1"]
    D --> P[("PostgreSQL canonical state history")]
    P --> Stream["Committed state-update stream"]
~~~

The execution context is immutable. The state snapshot is a consistent read at one version. A node cannot observe half of another node's commit.

**Global state** belongs to the execution and is visible subject to declared paths. **Local state** belongs to a node activation or component instance. **Scoped variables** use lexical scope ids. **Immutable variables** are written exactly once during scope creation. **Mutable variables** are changed only through versioned write intents.

### 3.6.2 State document and versions

Each execution has one logical state document. Storage may split it into typed fragments, but a committed state_version defines a consistent root manifest:

~~~json
{
  "execution_id": "019...uuidv7",
  "version": 482,
  "parent_version": 481,
  "schema_revision_id": "019...uuidv7",
  "root_hash": "sha256:...",
  "fragments": {
    "/case": {"inline": {"status": "review"}},
    "/evidence": {
      "artifact": "s3://opaque-content-address/evidence/sha256...",
      "hash": "sha256:...",
      "bytes": 943201
    }
  }
}
~~~

The root manifest is canonical. A cache may materialize a merged JSON view. State versions are append-only; compaction creates a new snapshot artifact without deleting deltas still required by retention or replay.

### 3.6.3 Read and write sets

At claim time WorkerGateway supplies snapshot version V plus the CompiledPlan-derived path capabilities. The sandbox returns only worker intent data; it does not choose mutability, conflict policy, reducer digest, or write authority:

~~~json
{
  "base_state_version": 481,
  "intents": [
    {
      "path": "/case/assessment",
      "operation": "PUT",
      "expected_path_version": 37,
      "expected_value_hash": "sha256:...",
      "inline_value": {"score": 0.92, "route": "manual"}
    },
    {
      "path": "/evidence/items",
      "operation": "REDUCE",
      "dedupe_key": "report:84",
      "value_artifact_id": "019fd4b4-6000-7000-8000-000000000201"
    }
  ]
}
~~~

The worker-intent vocabulary is canonical in `runtime.proto`, [Chapter 5](./05-shared-state.md), and [Chapter 14](./14-data-model.md): `PUT`, `DELETE`, `REDUCE`, `BIND_ARTIFACT`, and `CLOSE_SCOPE`. Mutability, conflict action, and reducer identity are resolved only from the pinned CompiledPlan. The required lowering is:

| Compiled path policy | Worker intent | Persisted operation | Persisted conflict policy | Required guard |
|---|---|---|---|---|
| `IMMUTABLE` initializer | compiler/initializer `PUT` | `PUT` | `FAIL_CONFLICT` | path absent, reserved initializer identity, initialization phase |
| `SINGLE_ASSIGNMENT` | `PUT` or `BIND_ARTIFACT` | same | `FAIL_CONFLICT` | path absent; identical duplicate by dedupe key is idempotent |
| `COMPARE_AND_SET` assignment | `PUT` or `BIND_ARTIFACT` | same | pinned action | `expected_path_version`; optional value hash strengthens comparison |
| `COMPARE_AND_SET` removal | `DELETE` | `DELETE` | pinned action | `expected_path_version` |
| `REDUCER` | `REDUCE` | `REDUCE` | `APPLY_REDUCER` | gateway supplies pinned pure reducer digest; canonical order and dedupe contract |
| Scope owner | `CLOSE_SCOPE` | `CLOSE_SCOPE` with stored mutability `IMMUTABLE` | `FAIL_CONFLICT` | no value; all child obligations terminal and scope still open |

`FAIL_CONFLICT`, `RECOMPUTE`, `APPLY_REDUCER`, and `SERIALIZE_SCOPE` control what WorkerGateway and the coordinator do after a storage conflict and are stored with the committed intent for replay. They are never supplied by the worker. Scope closure is a one-way terminal transition, so its canonical delta uses the existing `IMMUTABLE` mutability value rather than inventing a fifth worker-selectable state mutability. A custom reducer is represented only by `APPLY_REDUCER` plus a pinned reducer digest. WorkerGateway validates the path declaration, operation, value schema, artifact commitment, and ExecutionGrant before applying this table.

### 3.6.4 MVCC commit

~~~text
commit_state(execution, activation, routing_epoch, scheduler_fence,
             attempt_ordinal, fencing_token,
             plan_hash, base_version, intents):
    begin transaction
    require execution routing_epoch and plan_hash match
    require scheduler_fence when this transition consumes scheduler ownership
    require token owner, attempt_ordinal, and fencing_token match
    require token lease_expires_at > database_now()
    lock state_document(execution)
    require activation still RUNNING
    current = state_document.current_version

    for intent in canonical_path_order(intents):
        validate schema, classification, scope, and write capability
        compiled_rule = CompiledPlan.state_rule(intent.path)
        intervening = deltas touching overlapping_path(intent.path)
                      between base_version and current
        resolved = lower_and_resolve(compiled_rule, intent, intervening)
        if resolved is CONFLICT:
            abort with typed STATE_CONFLICT

    next = current + 1
    persist delta(base_version, current, next, intents, result_hash)
    update state root manifest and current_version using compare-and-set
    append StateCommitted event and projector outbox message
    commit
~~~

The transaction serializes commits per execution, not node computation. This is acceptable because state deltas are small. A graph with extremely high write frequency should partition independent work into child executions rather than weaken consistency.

### 3.6.5 Pinned conflict actions

| CompiledPlan action | Legal context | Semantics | Requirement |
|---|---|---|---|
| `FAIL_CONFLICT` | any non-reducer path | Reject an overlapping incompatible write with typed `STATE_CONFLICT` | default for protected business state |
| `RECOMPUTE` | `PURE` or policy-approved `READ_ONLY` activation | issue a new snapshot and recompute without pretending the stale result committed | effect-free retry path and bounded retry count |
| `APPLY_REDUCER` | `REDUCER` path and `REDUCE` intent | apply the plan-pinned reducer under canonical ordering/dedupe rules | reducer digest, schema, associativity/ordering contract, conformance tests |
| `SERIALIZE_SCOPE` | declared scope with competing writers | admit only one writer activation for that scope at a time | durable scope ownership and fairness/timeout bounds |

The committed `state_delta_intent` stores the resolved action, mutability, and reducer digest so replay does not consult mutable policy. A worker supplies none of these fields. Last-writer-wins is not a general action. JSON Merge Patch on a whole object is unsafe because sibling writes can be erased; use path-level intents. Floating-point sum is not strictly associative; reducers use fixed-point/decimal accumulation or a persisted order.

### 3.6.6 Branch and subgraph synchronization

A branch receives a snapshot plus a branch-local overlay. Join behavior must specify:

- exported paths from each branch;
- merge policy per path;
- deterministic branch order when order matters;
- behavior when a branch fails, is skipped, or is cancelled;
- whether partial values are visible to a COLLECT join.

Child executions do not directly write parent state. They return typed outputs; the parent applies them through one fenced MVCC commit. This makes remote subgraphs and retries tractable.

### 3.6.7 Incremental updates and streaming updates

Only committed deltas are externally visible. A worker may emit ephemeral progress frames, but they are labeled tentative and are not state:

~~~text
attempt progress -> low-latency stream -> UI (tentative, may vanish)
state transaction -> StateCommitted event -> durable stream (authoritative)
~~~

Durable consumers subscribe by execution and state version. Each StateDelta event contains version, changed path summaries, classification-filtered previews, hashes, and artifact references. Consumers acknowledge a monotonically increasing version and deduplicate by delta id.

A STREAM port is separate from shared-state streaming. It defines:

- partition key and per-partition sequence;
- AT_LEAST_ONCE or EFFECTIVELY_ONCE_WITH_DEDUPE delivery;
- bounded buffer, maximum item bytes, and credit-based backpressure;
- watermark/completion frame;
- resume cursor and retention;
- policy for producer failure and late items.

Streaming consumers must persist their cursor with any resulting state transition when atomicity is required.

## 3.7 Serialization and hashing

### 3.7.1 Canonical forms

| Use | Encoding | Rule |
|---|---|---|
| Source, semantic-plan, and envelope hashes | RFC 8785-style canonical JSON | UTF-8, sorted object keys, normalized numbers, no NaN/Infinity |
| Service-to-service commands/events | Protobuf with schema registry | Unknown fields preserved; field numbers never reused |
| Public API | JSON | Validated against pinned JSON Schema; explicit time/decimal formats |
| Large values | Content-addressed object | Hash and length stored canonically in PostgreSQL |
| Tabular/large model data | Arrow/Parquet artifact | Schema fingerprint and row count in manifest |
| Logs | Structured JSON/Protobuf batches | Redacted before persistence |

Three hashes have deliberately different projections:

| Hash | Included projection | Explicit exclusions |
|---|---|---|
| `source_hash` | Canonical committed GraphSpec source bytes, including presentation/extensions committed in that GraphVersion | GraphVersion transport envelope, `source_hash` itself, signatures, mutable storage URLs, upload metadata |
| `plan_hash` | Canonical executable CompiledPlan projection: interface/types, lowered nodes/edges/loops, exact dependency and implementation digests, state rules, effects, budgets, and executable policy declarations | GraphVersion/Compilation/CompiledPlan entity IDs, source parents, layout/comments, source maps, diagnostics, build timestamps, signatures, artifact locations, search/analytics/cache fields |
| `envelope_hash` | Canonical signed envelope: entity IDs, `source_hash`, `plan_hash`, compiler/toolchain identity, dependency-lock hash, worker compatibility set, plan-artifact manifest hash, creation metadata, and signature-key ID | `envelope_hash` itself, signature bytes, mutable signed URLs/replica locations, encryption ciphertext, and all rebuildable projections |

Consequently, a layout-only commit creates a different GraphVersion/source hash but may reuse an identical semantic plan hash. Identical executable semantics produced by another Compilation have the same semantic plan hash but a different envelope hash. A change to executable configuration, dependency digest, reducer, effect declaration, or policy semantics changes the semantic plan hash.

Every digest uses this byte-exact, length-framed ASCII preimage; `domain` and `schema_id` are registry-controlled ASCII without newlines:

~~~text
digest(domain, schema_id, canonical_bytes) = SHA-256(
  "ege:v1\n" || domain || "\n" || schema_id || "\n" ||
  decimal_utf8_byte_length(canonical_bytes) || "\n" || canonical_bytes
)
~~~

Registered domains are `graph-source`, `compiled-plan-semantics`, and `signed-envelope`. Deterministic runtime identities use their own domains such as `activation` and `effect`. Concatenated identity inputs are themselves canonical arrays/objects, never ambiguous raw string concatenation. The signature signs `envelope_hash`; it is not part of the hashed envelope.

Normative SHA-256 test vectors for canonical bytes `{"a":1}` (seven UTF-8 bytes) are:

| Domain | Schema ID | Expected digest |
|---|---|---|
| `graph-source` | `urn:ege:graph-spec:v1` | `sha256:a8f2973d8e1466c451fd800fa7ab5acfeae6652704f08cfea58687bde9fd0a53` |
| `compiled-plan-semantics` | `urn:ege:compiled-plan:v1` | `sha256:86b88576744b31995c2a12b30c340fe3608ebfc6a6df839b3c36b802d3435d24` |
| `signed-envelope` | `urn:ege:compiled-plan-envelope:v1` | `sha256:fa0c0e96447aec691112f13b87a8b4c09aa81e9739b36ec492d92a7e499e1a54` |

Conformance fixtures also prove: JSON object-key reordering preserves every digest; a layout-only source change changes only `source_hash` and `envelope_hash`; changing only compiler diagnostics preserves the semantic plan hash; and changing an implementation digest changes both semantic plan and envelope hashes.

### 3.7.2 Value envelope

~~~json
{
  "schema_ref": "urn:tenant:claims:Decision:v3",
  "encoding": "canonical-json",
  "classification": "CONFIDENTIAL",
  "inline": {"route": "manual", "score": 0.92},
  "artifact_ref": null,
  "content_hash": "sha256:...",
  "byte_length": 31
}
~~~

Exactly one of inline or artifact_ref is present. Inline thresholds are configurable by classification and tenant, normally 64–256 KiB. Compression occurs after hashing canonical plaintext; encryption occurs after compression. Artifact manifests record algorithms and key versions.

### 3.7.3 Schema evolution

State and value schemas are immutable revisions. A CompiledPlan pins their exact digests. Migration is an explicit, replayable node or deployment operation that:

1. reads version N;
2. produces a value conforming to version N+1;
3. records migration implementation digest, input/output hashes, and validation;
4. commits a new state version.

Readers do not silently reinterpret old bytes under a new schema.

## 3.8 State memory management

The runtime enforces per-value, per-delta, per-execution, per-stream, and per-tenant limits. Large values spill to object storage. WorkerGateway exposes only declared read paths; a WorkerSupervisor or sandbox receives short-lived artifact credentials scoped to exact object IDs, never database credentials.

Compaction rules:

- preserve every semantic delta through the replay/audit retention window;
- periodically materialize a verified full snapshot;
- retain at least two validated checkpoints before pruning older materializations;
- never prune data referenced by a legal hold, active fork, checkpoint, audit record, or unresolved effect;
- garbage-collect unreferenced content only after a grace period and reference scan;
- encrypt tenant artifacts with rotation-aware key versions;
- redact logs, not canonical state, unless an explicit privacy workflow creates a tombstone/crypto-shred record.

An execution approaching its state limit is backpressured before a write. The runtime returns STATE_LIMIT_EXCEEDED with path-size evidence; it does not truncate silently.

## 3.9 GraphVersion, Compilation, CompiledPlan, and deployment

Mutable source history, committed source, compiler attempts, executable plans, and deployments are distinct:

~~~mermaid
flowchart LR
    Draft["Mutable DraftBranch + CRDT history"] --> Commit["Commit GraphVersion V17\nsource_hash"]
    Commit --> C1["Compilation C91\ndiagnostics + toolchain"]
    C1 --> P1["CompiledPlan P44\nplan_hash + envelope_hash"]
    P1 --> D1["staging DeploymentRevision\nP44 + bindings"]
    P1 --> D2["production DeploymentRevision\nweighted plan traffic"]
    Commit --> Draft2["new DraftBranch parented by V17"]
    Draft2 --> V18["GraphVersion V18"]
~~~

A DeploymentRevision binds environment-specific, non-secret references: worker pool, model route, secret aliases, PolicySnapshot, quotas, placement, and weighted CompiledPlan traffic. Updating a deployment is versioned and audited. Admission records the selected GraphVersion, Compilation, CompiledPlan/plan hash, and binding snapshot; existing executions retain all pins.

Graph diffs operate on logical ids and semantic fields rather than raw JSON position. Change classification:

- cosmetic: layout/comment only, `source_hash` changes but `plan_hash` does not;
- compatible: additive optional port/metadata changes;
- behavior-changing: logic/config/implementation/prompt/policy change;
- interface-breaking: incompatible input/output or removed capability;
- state-breaking: incompatible state schema or reducer.

## 3.10 Validation matrix

| Validation phase | Examples | Failure result |
|---|---|---|
| Authoring | duplicate id, dangling connector, malformed expression | editor diagnostic |
| Compile | type mismatch, uncontrolled cycle, unresolved package, illegal scope write | publish blocked |
| Deploy | revoked plugin, unavailable capability, residency mismatch, missing secret alias | deployment blocked |
| Admission | invalid input, quota/budget, caller policy, disabled deployment/CompiledPlan | admission decision/API error; no Execution row |
| Activation | dynamic capability, current policy, state write permissions | activation failed/quarantined |
| Completion | output schema, state conflict, artifact hash, current fence | commit rejected or conflict routed |

Validation must be side-effect-free and deterministic. Plugin-provided validators execute in a restricted compiler sandbox and cannot fetch unpinned network resources.

## 3.11 Decisions, alternatives, and failure modes

| Decision | Chosen because | Alternative | Trade-off / failure mode |
|---|---|---|---|
| Separate authoring model from IR | Stable runtime semantics and reproducible builds | Execute canvas JSON | Requires compiler/source maps; eliminates UI-default drift |
| JSON Schema types with named registry | Public interoperability and strong validation | Language-specific types only | Some advanced type relations need compiler rules |
| Lexical scoped state | Makes ownership and subgraph reuse explicit | One global dictionary | More declarations; far fewer accidental collisions |
| MVCC plus typed conflict policies | Parallel computation without lost updates | Global state lock or last-write-wins | Conflicts can cause retries; correctness is visible |
| Content-addressed large values | Deduplication and verifiable replay | Inline all JSON | Object lifecycle and encryption are operational concerns |
| Exact package locks | Supply-chain and replay integrity | Resolve “latest” at execution | Publishing does more work; executions remain stable |
| Child output commit, no direct parent writes | Isolation, remote placement, retry safety | Shared distributed mutable state | Large outputs need artifacts; recovery is bounded |
| PostgreSQL canonical, projections rebuildable | One authorization/version authority | Graph DB or cache as truth | Projection lag is expected and monitored |

Failure cases and required behavior:

- **Schema registry unavailable at runtime:** execution proceeds using schemas embedded/referenced in the admitted CompiledPlan; new Compilation/deployment stops.
- **State conflict:** route a typed conflict edge, retry the pure computation on a new snapshot, or fail; never overwrite.
- **Reducer version missing:** quarantine the activation and dependency; do not substitute a newer reducer.
- **Artifact exists with wrong hash:** reject it, emit integrity incident, and never expose the value.
- **Dynamic fragment references unauthorized plugin:** reject the entire fragment before materialization.
- **Package revocation during an execution:** policy determines continue or cancel; the decision and revocation version are recorded. New attempts must recheck.
- **Projection shows stale graph/state:** all mutation and authorization APIs re-read PostgreSQL; UI displays projection lag.
- **Oversized state/stream:** apply backpressure or fail with a typed limit; never drop canonical values.

## 3.12 Implementation acceptance tests

The graph/state layer is not complete until tests prove:

1. semantically identical GraphVersions produce byte-identical executable projections and semantic plan hashes;
2. layout/comment-only edits change source hash while preserving semantic plan hash;
3. every illegal cycle, scope escape, unresolved port, unsafe coercion, and mutable package range is rejected;
4. old GraphVersions and CompiledPlans remain executable after later source changes or compiler attempts;
5. two parallel `COMPARE_AND_SET` writers produce one commit and one typed conflict;
6. a plan-pinned append-unique reducer deduplicates repeated completion by stable item key;
7. REDUCE produces the same result under randomized completion order;
8. child cancellation cannot leak a late parent-state write;
9. stream resume from a persisted cursor neither loses nor silently duplicates an effect;
10. a full state snapshot is rebuildable from canonical deltas and artifact manifests;
11. deleting Redis/search/analytics projections changes performance, not correctness;
12. corrupt schema, artifact, package, or state hashes fail closed with an auditable record;
13. normative source/plan/envelope hash vectors and exclusion fixtures pass byte-for-byte;
14. execution admission rejects any mismatch among GraphVersion, Compilation, CompiledPlan, dependency lock, envelope, and plan hash;
15. every GraphSpec state policy lowers to the Chapter 5 worker intent and Chapter 14 persisted operation specified in Section 3.6.3.
