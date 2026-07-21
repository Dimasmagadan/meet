---
description: >
  Analyze a codebase and generate a CLAUDE.md (or AGENTS.md) file that gives
  future AI instances of yourself everything they need to work effectively in this
  project. Covers architecture, conventions, build commands, gotchas, and rules.
  Use when the user says "create CLAUDE.md", "generate AGENTS.md", "setup AI
  instructions", "bootstrap project docs", or "analyze codebase for AI context".
argument-hint: "[--output CLAUDE.md|AGENTS.md] [--scope full|minimal]"
---

# CLAUDE.md Generator

Analyze the current codebase and produce a comprehensive CLAUDE.md (or AGENTS.md) file that gives future AI instances everything they need to work effectively.

## Analysis Steps

1. **Project Identity**
   - What is this project? (name, purpose, target platform)
   - What's the tech stack? (languages, frameworks, key dependencies)
   - What's the current status? (MVP, production, maintenance)

2. **Architecture**
   - Directory structure overview
   - Key modules and their responsibilities
   - Data flow (inputs → processing → outputs)
   - External integrations and APIs

3. **Build & Run**
   - How to install dependencies
   - How to build
   - How to run locally
   - How to run tests
   - Key environment variables or config files

4. **Conventions**
   - Naming patterns (files, functions, variables)
   - Code style (formatting, linting rules)
   - Commit message format
   - Branch naming
   - Test organization

5. **Critical Gotchas**
   - Non-obvious behavior that trips up newcomers
   - Platform-specific quirks
   - Performance pitfalls
   - Security considerations
   - Known technical debt

6. **Current Rules**
   - Read project MEMORY.md for existing rules and decisions
   - Read any existing CLAUDE.md or AGENTS.md
   - Check for .editorconfig, .prettierrc, eslint configs
   - Preserve existing rules; add new ones only if missing

## Output Format

```markdown
# {Project Name}

{One-line description}

## Tech Stack

- **Language**: {primary language}
- **Framework**: {framework}
- **Build**: {build tool}
- **Test**: {test framework}

## Quick Start

```bash
# Install
{install command}

# Build
{build command}

# Run
{run command}

# Test
{test command}
```

## Architecture

{Directory structure overview with key modules}

## Conventions

{Naming, formatting, commit conventions}

## Critical Gotchas

{Non-obvious behavior, platform quirks, pitfalls}

## Rules

{Project-specific rules that every session must respect}
```

## Rules

- Be concise: future AI reads this on every session start; keep it scannable
- Be accurate: verify commands actually work before listing them
- Preserve existing content: if CLAUDE.md already exists, update it don't replace it
- Include gotchas: the most valuable section is what's NOT obvious from reading code
- Check MEMORY.md: incorporate durable knowledge from project memory
