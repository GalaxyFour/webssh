"""Reject private development artifacts from the public repository."""

from __future__ import annotations

import re
import subprocess
from dataclasses import dataclass
from pathlib import Path, PurePosixPath


ROOT = Path(__file__).resolve().parents[1]

FORBIDDEN_NAMES = frozenset({
    '.cursorrules',
    '.clinerules',
    '.roorules',
    '.windsurfrules',
    'agents.md',
    'agent-instructions.md',
    'ai_instructions.md',
    'claude.md',
    'codex.md',
    'copilot.md',
    'copilot-instructions.md',
    'gemini.md',
    'jules.md',
    'qwen.md',
})

FORBIDDEN_DIRECTORIES = frozenset({
    '.agent',
    '.agents',
    '.aider',
    '.ai',
    '.amazonq',
    '.claude',
    '.codex',
    '.continue',
    '.cursor',
    '.gemini',
    '.junie',
    '.pytest_cache',
    '.superpowers',
    '.test-run.tmp',
    '.test-tmp',
    '.windsurf',
    '__pycache__',
    'graphify-out',
    'node_modules',
    'plans',
    'playwright-report',
    'qa-artifacts',
    '.roo',
    'review-artifacts',
    'reviews',
    'test-results',
})

DISPOSABLE_SUFFIXES = (
    '.bak', '.db', '.log', '.orig', '.pyc', '.pyo', '.rej', '.sqlite',
    '.sqlite3', '.swp', '.swo',
)

PUBLIC_REFERENCE_SUFFIXES = frozenset({'.css', '.html', '.js', '.md'})
TEXT_AUDIT_SUFFIXES = frozenset({'.adoc', '.html', '.md', '.rst', '.txt'})

AGENT_INSTRUCTION_MARKERS = (
    re.compile(
        r'^\s*#{1,6}\s*(?:(?:ai|coding)\s+)?agents?\s+'
        r'(?:instructions|rules|guidelines)\b',
        re.IGNORECASE | re.MULTILINE,
    ),
    re.compile(
        r'^\s*#{1,6}\s*(?:codex|claude|gemini)\s+'
        r'(?:instructions|rules|guidelines)\b',
        re.IGNORECASE | re.MULTILINE,
    ),
    re.compile(
        r'\byou are (?:an?\s+)?(?:codex|claude|gemini|ai coding agent)\b',
        re.IGNORECASE,
    ),
    re.compile(
        r'<(?:agents|agent_instructions|skills_instructions|developer_instructions)\b',
        re.IGNORECASE,
    ),
)

LOCAL_TOOL_PATH_MARKERS = (
    re.compile(
        r'/(?:home|Users)/[^/\s`"\']+/\.(?:agents|claude|codex|cursor)(?:/|\b)',
        re.IGNORECASE,
    ),
    re.compile(
        r'[A-Z]:\\Users\\[^\\\s`"\']+\\\.(?:agents|claude|codex|cursor)(?:\\|\b)',
        re.IGNORECASE,
    ),
    re.compile(r'/tmp/(?:codex[-_/]|[^/\s`]*?(?:capture|comparison|screenshot)[^/\s`]*)', re.IGNORECASE),
    re.compile(r'https://claude\.ai/code/session_', re.IGNORECASE),
)

INTERNAL_REVIEW_MARKERS = (
    re.compile(
        r'^\s*[-*]\s*(?:source visual truth|browser-rendered implementation|'
        r'combined full-view evidence):',
        re.IGNORECASE | re.MULTILINE,
    ),
)


@dataclass(frozen=True, order=True)
class Violation:
    path: str
    reason: str


def tracked_paths(root: Path = ROOT) -> list[str]:
    result = subprocess.run(
        ['git', 'ls-files', '-z'],
        cwd=root,
        check=True,
        stdout=subprocess.PIPE,
    )
    return [
        value.decode('utf-8', errors='surrogateescape')
        for value in result.stdout.split(b'\0')
        if value
    ]


def forbidden_path_reason(value: str) -> str | None:
    path = PurePosixPath(value)
    parts = tuple(part.casefold() for part in path.parts)
    name = path.name.casefold()
    if name in FORBIDDEN_NAMES:
        return 'local agent or assistant instruction file'
    if name.startswith('.aider'):
        return 'local agent or assistant configuration file'
    forbidden_component = next(
        (part for part in parts if part in FORBIDDEN_DIRECTORIES),
        None,
    )
    if forbidden_component:
        return f'private or generated directory: {forbidden_component}'
    if '.github' in parts and any(
        part in {'instructions', 'prompts'} for part in parts
    ):
        return 'repository-local AI instruction directory'
    if name == '.env' or (name.startswith('.env.') and name != '.env.example'):
        return 'environment or secret file'
    if name in {'.ds_store', 'thumbs.db'} or name.endswith(DISPOSABLE_SUFFIXES):
        return 'disposable workstation or runtime artifact'
    if path.suffix.casefold() == '.md' and re.search(
        r'(?:^|[-_])(design[-_])?(?:qa|review)(?:[-_.]|$)',
        name,
        re.IGNORECASE,
    ):
        return 'internal QA or review Markdown'
    return None


def _read_text(path: Path) -> str | None:
    try:
        return path.read_text(encoding='utf-8')
    except (OSError, UnicodeError):
        return None


def content_violations(root: Path, paths: list[str]) -> list[Violation]:
    violations: list[Violation] = []
    for value in paths:
        path = PurePosixPath(value)
        if path.suffix.casefold() not in TEXT_AUDIT_SUFFIXES:
            continue
        text = _read_text(root / value)
        if text is None:
            continue
        if any(pattern.search(text) for pattern in AGENT_INSTRUCTION_MARKERS):
            violations.append(Violation(value, 'embedded AI-agent instructions'))
        if any(pattern.search(text) for pattern in LOCAL_TOOL_PATH_MARKERS):
            violations.append(Violation(value, 'workstation-specific AI or QA path'))
        if any(pattern.search(text) for pattern in INTERNAL_REVIEW_MARKERS):
            violations.append(Violation(value, 'internal visual-review evidence'))
    return violations


def asset_violations(root: Path, paths: list[str]) -> list[Violation]:
    public_sources = []
    for value in paths:
        path = PurePosixPath(value)
        if path.suffix.casefold() not in PUBLIC_REFERENCE_SUFFIXES:
            continue
        if value == 'README.md' or path.parts[0] in {'docs', 'site'}:
            text = _read_text(root / value)
            if text is not None:
                public_sources.append(text)
    public_text = '\n'.join(public_sources)
    violations = []
    for value in paths:
        path = PurePosixPath(value)
        if not path.parts or path.parts[0] != 'assets':
            continue
        if path.name not in public_text and value not in public_text:
            violations.append(Violation(value, 'asset has no public documentation or site reference'))
    return violations


def scan_repository(root: Path = ROOT, paths: list[str] | None = None) -> list[Violation]:
    paths = tracked_paths(root) if paths is None else paths
    violations = [
        Violation(value, reason)
        for value in paths
        if (reason := forbidden_path_reason(value)) is not None
    ]
    violations.extend(content_violations(root, paths))
    violations.extend(asset_violations(root, paths))
    return sorted(set(violations))


def main() -> int:
    violations = scan_repository()
    if violations:
        print('Repository hygiene check failed:')
        for violation in violations:
            print(f'- {violation.path}: {violation.reason}')
        return 1
    print('Repository hygiene check passed: tracked files are public-safe.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
