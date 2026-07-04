---
name: project-review
description: >
  Comprehensive project review covering architecture, code quality, usability,
  and improvement opportunities. Produces a structured review report with
  prioritized findings. Use when the user says "review project", "project review",
  "code review", "architecture review", "review this project", or asks to assess
  a codebase's health and improvement opportunities.
argument-hint: "[--focus architecture|usability|performance|all] [--output file]"
---

# Project Review Skill

Perform a structured review of the current project. Produce actionable findings organized by priority.

## Review Dimensions

Assess the project across these dimensions (adjust focus based on user request):

### 1. Architecture & Structure
- Project organization and module boundaries
- Dependency management and coupling
- Separation of concerns
- Data flow and state management patterns
- Error handling strategy

### 2. Code Quality
- Code duplication and DRY violations
- Naming consistency and clarity
- Function/method complexity (size, nesting, responsibility)
- Type safety and validation
- Dead code and unused dependencies

### 3. Build & Tooling
- Build configuration and optimization
- Development workflow friction points
- Testing coverage and strategy
- CI/CD pipeline completeness
- Environment setup reliability

### 4. Usability & Developer Experience
- API design and ergonomics
- Documentation completeness
- Onboarding difficulty for new contributors
- Configuration complexity
- Error messages and debugging aids

### 5. Performance
- Startup time and bundle size
- Runtime hot paths
- Memory usage patterns
- Caching strategy
- Scalability bottlenecks

## Review Process

1. **Discover the project**: Read package.json, README, main entry points, and directory structure
2. **Identify the tech stack**: Languages, frameworks, build tools, dependencies
3. **Sample key files**: Read 5-10 representative source files to assess patterns
4. **Check configuration**: Build configs, linting, testing setup
5. **Look for red flags**: TODO/FIXME comments, hardcoded values, obvious anti-patterns
6. **Cross-reference with memory**: Check project MEMORY.md for known issues and architecture decisions

## Output Format

```markdown
# Project Review: {project-name}
**Date**: YYYY-MM-DD
**Focus**: {dimension or "all"}

## Executive Summary
2-3 sentence overview of project health and key findings.

## Findings

### Critical (fix now)
- [FINDING-001] Title
  - What: Description of the issue
  - Where: File:line or module
  - Why: Impact and risk
  - Fix: Recommended action

### Important (fix soon)
- ...

### Nice to Have (improve when possible)
- ...

## Architecture Diagram
Brief textual description of key components and their relationships.

## Improvement Roadmap
Ordered list of recommended changes with effort estimates (S/M/L/XL).
```

## Rules

- Be specific: cite file paths and line numbers when possible
- Be constructive: every finding should include a recommended fix
- Prioritize: not everything is critical; help the user focus
- Respect existing decisions: check MEMORY.md for architecture decisions before criticizing
- Don't rewrite: suggest changes, don't make them unless explicitly asked
