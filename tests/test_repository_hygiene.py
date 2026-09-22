from pathlib import Path

import pytest

from scripts.check_repository_hygiene import (
    asset_violations,
    content_violations,
    forbidden_path_reason,
    scan_repository,
)


@pytest.mark.parametrize('path', [
    'AGENTS.md',
    'docs/CLAUDE.md',
    '.codex/settings.toml',
    '.aider.conf.yml',
    '.cursor/rules/project.mdc',
    '.amazonq/rules/project.md',
    '.windsurfrules',
    'QWEN.md',
    '.github/copilot-instructions.md',
    '.github/instructions/backend.instructions.md',
    'docs/reviews/2026-09-21/README.md',
    'notes/workspace-ux-review.md',
    'graphify-out/graph.html',
    'test-results/failure.png',
    '.env.production',
    'server.sqlite3',
])
def test_private_and_generated_paths_are_rejected(path):
    assert forbidden_path_reason(path)


@pytest.mark.parametrize('path', [
    'README.md',
    'SECURITY.md',
    'docs/wiki/Development-and-Testing.md',
    'tests/e2e/review-regressions.spec.js',
    '.env.example',
    'docs/media/diagrams/system-trust-boundaries.svg',
])
def test_public_project_paths_remain_allowed(path):
    assert forbidden_path_reason(path) is None


@pytest.mark.parametrize('content', [
    '# Agent instructions\nAlways run the local tool.',
    'You are Codex. Modify this repository.',
    '<skills_instructions>private workflow</skills_instructions>',
    'Evidence lives at /home/developer/.codex/visualizations/mock.html',
    '- Source visual truth: /tmp/codex-clipboard-image.png',
])
def test_instruction_and_workstation_markers_are_rejected(tmp_path, content):
    target = tmp_path / 'notes.md'
    target.write_text(content, encoding='utf-8')
    assert content_violations(tmp_path, ['notes.md'])


def test_assets_must_have_a_public_reference(tmp_path):
    (tmp_path / 'assets').mkdir()
    (tmp_path / 'assets' / 'public.png').write_bytes(b'png')
    (tmp_path / 'assets' / 'orphan.png').write_bytes(b'png')
    (tmp_path / 'README.md').write_text('![Product](assets/public.png)', encoding='utf-8')
    violations = asset_violations(
        tmp_path,
        ['README.md', 'assets/public.png', 'assets/orphan.png'],
    )
    assert [(item.path, item.reason) for item in violations] == [
        ('assets/orphan.png', 'asset has no public documentation or site reference'),
    ]


def test_current_tracked_tree_is_public_safe():
    root = Path(__file__).resolve().parents[1]
    assert scan_repository(root) == []


def test_required_ci_gate_runs_hygiene_before_change_classification():
    root = Path(__file__).resolve().parents[1]
    workflow = (root / '.github' / 'workflows' / 'tests.yml').read_text(
        encoding='utf-8',
    )
    hygiene = workflow.index('python scripts/check_repository_hygiene.py')
    classification = workflow.index('python scripts/ci_change_scope.py')
    assert hygiene < classification
