---
name: frame-ui-motion
description: Apply restrained, accessible motion feedback to Frame skeleton reveals and bookmark state changes.
---

# Frame UI motion

## Status and scope

This project-local guidance governs Frame's restrained skeleton pulse, artwork hover, filter feedback, and bookmark state feedback. The current implementation uses local CSS motion tokens and a global `prefers-reduced-motion` override; it does not install transitions.dev selector hooks or a motion library. Do not introduce decorative page choreography, card tilt, unrelated transitions, or backend/full-stack/RAG/document-conversion work. [AC-7, AC-8]

## Decision

1. Keep skeleton loading understandable through `aria-busy` and status text; the CSS pulse is optional feedback and must collapse under reduced motion.
2. Keep bookmark state exposed through its accessible name and `aria-pressed`; fill/scale feedback is supplemental.
3. If a later approved node replaces either behavior with the supplied **Skeleton loader and reveal** (`14-skeleton-reveal.md`) or **Icon swap** (`09-icon-swap.md`) pattern, follow the installation rules below. Otherwise leave the existing motion static or restrained.

## Required installation behavior

- Copy a selected pinned snippet verbatim only during an approved implementation node; do not reconstruct it from memory.
- Install the shared motion variables once in the global stylesheet, or the single snippet's root variables when only one pattern is used. Never duplicate token blocks.
- Wire only the documented classes/state attributes and adapt JS selectors to Frame's DOM. Keep `getComputedStyle(...).getPropertyValue("--…")` timing reads where the selected snippet requires orchestration.
- Preserve each snippet's complete `@media (prefers-reduced-motion: reduce)` guard. Reduced-motion mode must remove nonessential animation while state changes remain immediately understandable.
- Never replace enumerated transition properties with `transition: all`.

## Verification boundary

- Inspect both normal and reduced-motion rendering after implementation.
- Confirm keyboard bookmark activation produces the same persisted state and accessible announcement as pointer activation.
- Confirm skeletons are removed/revealed once, including retry and stale-response paths.

Automated tests exercise gallery state and data behavior, but these normal/reduced-motion and keyboard checks still need operator browser receipts. Any prior live-trial note is historical operator evidence only; complete final interactions, viewport/overflow, contrast, and browser accessibility remain pending. This document does not claim that motion or accessibility has passed. [AC-7, AC-8]
