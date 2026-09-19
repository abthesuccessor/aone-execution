#!/usr/bin/env python3
"""Mechanical completeness and structure checks for the architecture book.

This does not replace architectural review. It prevents accidental omission of a
brief topic, broken internal link, malformed JSON contract, or unbalanced fence.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from urllib.parse import unquote


ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / "docs"

EXPECTED = [DOCS / "ARCHITECTURE.md"] + [
    DOCS / "chapters" / f"{number:02d}-{slug}.md"
    for number, slug in [
        (1, "platform-vision"),
        (2, "runtime-architecture"),
        (3, "graph-model-and-state"),
        (4, "node-system"),
        (5, "shared-state"),
        (6, "loop-engineering"),
        (7, "product-ux"),
        (8, "developer-experience"),
        (9, "observability"),
        (10, "security-governance"),
        (11, "scalability-reliability"),
        (12, "ai-intelligence"),
        (13, "plugin-system"),
        (14, "data-model"),
        (15, "repository-structure"),
        (16, "technology-stack"),
        (17, "engineering-decisions"),
    ]
]

TOPICS: dict[str, list[str | tuple[str, ...]]] = {
    "vision": [
        "graph engineering", "prompt engineering", "context engineering",
        "loop engineering", "workflow", "execution graph", "state machine",
        "dag", "knowledge graph",
    ],
    "runtime": [
        "scheduler", "execution engine", "checkpoint", "recovery", "persistence",
        "replay", "retries", "timeouts", "cancellation", "dead letter queue",
        "parallel execution", "fan out", "fan in", "conditional branching",
        "loop execution", "subgraph", "nested graph", "dynamic graph generation",
        "graph expansion", "distributed execution", "multi worker scheduling",
        "execution token", "execution context", "execution metadata",
        "execution history",
    ],
    "graph_model": [
        "node", "edge", "port", "connector", "variable", "scope", "memory",
        "input", "output", "shared state", "execution state", "metadata", "tags",
        "labels", "version", "namespace", "reusable components", "template",
        "package", "plugin",
    ],
    "nodes": [
        "llm node", "prompt node", "function node", "python node",
        "javascript node", "rust worker", "database node", "rest api node",
        "webhook node", "email node", "mcp tool node", "agent node", "memory node",
        "cache node", "human approval node", "delay node", "timer node",
        "condition node", "switch node", "loop node", "merge node", "fork node",
        "parallel node", "event node", "queue node", "embedding node",
        "retriever node", "reranker node", "vector search node",
        "knowledge graph node", "validation node", "security node", "policy node",
        "logging node", "metrics node", "custom plugin node", "serialization",
        "error handling",
    ],
    "state": [
        "global state", "local state", "scoped variables", "immutable variables",
        "mutable variables", "context", "execution snapshot", "incremental updates",
        "state versioning", "conflict resolution", "synchronization",
        "streaming updates", "memory management", "serialization strategy",
    ],
    "loops": [
        "retry loop", "reflection loop", "critic loop", "self improvement loop",
        "planning loop", "tool loop", "repair loop", "evaluation loop",
        "stopping condition", "maximum iterations", "cost limit", "time limit",
        "quality threshold", "confidence threshold", "loop detection",
        "infinite loop prevention", "loop metrics",
    ],
    "ux": [
        "dashboard", "projects", "graphs", "executions", "templates", "marketplace",
        "plugins", "settings", "users", "organizations", "audit logs", "secrets",
        "billing", "models", "knowledge", "memory", "api keys", "observability",
        "documentation", "developer portal", "drag and drop", "zoom", "mini map",
        "multi select", "alignment", "groups", "subgraphs", "comments",
        "live collaboration", "keyboard shortcuts", "auto layout", "search",
        "graph diff", "history", "undo", "redo", "copy", "paste",
        "version compare", "node editor", "edge editor", "execution inspector",
        "state viewer", "log viewer", "trace viewer", "timeline", "profiler",
        "cost viewer", "token viewer", "latency viewer",
    ],
    "dx": [
        "cli", "sdk", "rest api", "graph api", "graph dsl", "yaml format",
        "json format", "code first", "visual first", "live debugging", "breakpoint",
        "step execution", "replay", "mock execution", "local runtime",
        "remote runtime", "hot reload", "simulation", "unit testing",
        "integration testing", "graph testing", "golden tests", "snapshot tests",
    ],
    "observability": [
        "metrics", "tracing", "logging", "opentelemetry", "prometheus", "grafana",
        "cost tracking", "execution timeline", "node timeline", "heatmap",
        "critical path", "performance bottleneck", "failure analysis", "replay",
        "audit trail",
    ],
    "security": [
        "authentication", "authorization", "rbac", "abac", "secret management",
        "encryption", "execution isolation", "sandboxing", "rate limit",
        "input validation", "output validation", "policy enforcement",
        "prompt injection", "tool permission", "tenant isolation", "compliance",
    ],
    "scale": [
        "1 million graphs", "100 million executions", "horizontal scaling",
        "distributed workers", "queue system", "scheduling", "backpressure",
        "caching", "load balancing", "autoscaling", "geo distribution",
        "high availability", "disaster recovery",
    ],
    "ai": [
        "multi model routing", "model selection", "model fallback",
        "prompt versioning", "prompt registry", "context compression",
        "memory management", "embedding pipelines", "retrieval pipelines",
        "agent collaboration", "agent swarms", "tool calling", "structured output",
        "reflection", "self critique", "planning", "reasoning", "evaluation",
        "graph optimization", "automatic node suggestions",
        "automatic graph generation", "automatic graph refactoring",
        "automatic performance optimization",
    ],
    "plugins": [
        "plugin sdk", "plugin marketplace", "custom nodes", "tool registry",
        "version compatibility", "dependency management", "sandboxing", "signing",
        "permissions", "distribution",
    ],
    "data": [
        "er diagram", "runtime schema", "execution schema", "graph schema",
        "node schema", "edge schema", "state schema", "checkpoint schema",
        "log schema", "metrics schema", "audit schema", "version schema",
    ],
    "repository": [
        "frontend", "backend", "workers", "sdk", "cli", "infrastructure",
        "deployment", "testing", "documentation", "examples", "plugins", "runtime",
    ],
    "technology": [
        "frontend", "backend", "execution runtime", "queue", "database", "cache",
        "object storage", "graph storage", "vector storage", "search", "monitoring",
        "tracing", "authentication", "deployment", "container runtime", "kubernetes",
        "ci cd", "secrets", "messaging", "streaming",
    ],
    "decisions": [
        "why", "alternatives", "trade offs", "performance implications",
        "scalability implications", "failure modes", "operational complexity",
        "design patterns", "anti patterns", "best practices",
        "production recommendations",
    ],
    "artifacts": [
        "architecture diagram", "sequence diagram", "state diagram",
        "runtime flow", "component diagram", "data flow", "folder structure",
        "api example", "json schema", "yaml example", "database schema",
        "event schema", "pseudocode",
    ],
}


def normalize(value: str) -> str:
    value = value.lower()
    value = re.sub(r"[`*_]", "", value)
    value = re.sub(r"[^a-z0-9]+", " ", value)
    return re.sub(r"\s+", " ", value).strip()


def main() -> int:
    failures: list[str] = []
    missing_files = [path for path in EXPECTED if not path.is_file()]
    failures.extend(f"missing file: {path.relative_to(ROOT)}" for path in missing_files)

    markdown_files = sorted(DOCS.rglob("*.md"))
    corpus_parts: list[str] = []
    for path in markdown_files:
        text = path.read_text(encoding="utf-8")
        corpus_parts.append(text)
        for marker in ("```", "~~~"):
            fences = sum(
                1 for line in text.splitlines()
                if re.match(rf"^\s*{re.escape(marker)}", line)
            )
            if fences % 2:
                failures.append(
                    f"unbalanced {marker} fenced block: {path.relative_to(ROOT)}"
                )
        if text and not text.endswith("\n"):
            failures.append(f"missing final newline: {path.relative_to(ROOT)}")

        for match in re.finditer(r"\[[^\]]+\]\(([^)]+)\)", text):
            target = match.group(1).strip()
            target = target[1:-1] if target.startswith("<") and target.endswith(">") else target
            if not target or target.startswith(("#", "http://", "https://", "mailto:")):
                continue
            file_part = unquote(target.split("#", 1)[0])
            # Codex source links carry a line suffix; it is not part of the filename.
            file_part = re.sub(r":\d+$", "", file_part)
            if file_part and not (path.parent / file_part).resolve().exists():
                failures.append(
                    f"broken link in {path.relative_to(ROOT)}: {target}"
                )

    corpus = normalize("\n".join(corpus_parts))
    for section, topics in TOPICS.items():
        for topic in topics:
            alternatives = (topic,) if isinstance(topic, str) else topic
            if not any(normalize(candidate) in corpus for candidate in alternatives):
                failures.append(f"coverage [{section}]: {alternatives[0]}")

    for json_path in sorted(DOCS.rglob("*.json")):
        try:
            json.loads(json_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            failures.append(f"invalid JSON {json_path.relative_to(ROOT)}: {exc}")

    for proto in sorted((DOCS / "contracts").rglob("*.proto")):
        proto_text = re.sub(r"//.*", "", proto.read_text(encoding="utf-8"))
        if proto_text.count("{") != proto_text.count("}"):
            failures.append(f"unbalanced braces: {proto.relative_to(ROOT)}")

    words = len(re.findall(r"\b\w+[\w'-]*\b", "\n".join(corpus_parts)))
    diagrams = sum(
        text.count("```mermaid") + text.count("```text")
        + text.count("~~~mermaid") + text.count("~~~text")
        for text in corpus_parts
    )
    print(
        f"checked {len(markdown_files)} markdown files, {words:,} words, "
        f"{diagrams} diagram/text blocks"
    )

    if failures:
        print(f"FAILED with {len(failures)} issue(s):")
        for failure in failures:
            print(f"- {failure}")
        return 1

    print("architecture validation passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
