"""Public contracts for the GitHub Pages artifact."""

from pathlib import Path



ROOT = Path(__file__).resolve().parents[1]
PAGES_WORKFLOW = ROOT / ".github" / "workflows" / "graph-pages.yml"
GRAPHIFY_IGNORE = ROOT / ".graphifyignore"
LANDING_PAGE = ROOT / "site" / "index.html"


def test_pages_workflow_publishes_product_root_and_code_graph_subpath():
    """The Pages artifact keeps the product root separate from Graphify output."""
    workflow = PAGES_WORKFLOW.read_text(encoding="utf-8")

    assert "cp -R site/. _site/" in workflow
    assert "mkdir -p _site/code-graph" in workflow
    assert "cp graphify-out/graph.html _site/code-graph/index.html" in workflow


def test_code_graph_excludes_vendored_runtime_dependencies():
    """The public code graph stays focused on first-party project code."""
    patterns = {
        line.strip()
        for line in GRAPHIFY_IGNORE.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    }

    assert "/static/vendor/" in patterns
    assert "/site/vendor/" in patterns


def test_product_landing_page_uses_current_connection_terminology():
    """Public landing-page copy does not preserve labels replaced in the UI."""
    assert LANDING_PAGE.is_file(), "The public product landing page is missing."

    landing_page = LANDING_PAGE.read_text(encoding="utf-8")
    for obsolete_label in ("New Connection", "New SSH Connection", "Profiles"):
        assert obsolete_label not in landing_page
