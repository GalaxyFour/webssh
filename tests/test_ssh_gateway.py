"""Gateway selectors never widen ordinary SSH identities."""
import pytest
from app.ssh_gateway import parse_selector, tmux_name

@pytest.mark.parametrize("value", ["alice:server", "a@b.test:db:22", "Müller:Ziel", "a b:target"])
def test_explicit_selector_round_trips(value):
    assert ":".join(parse_selector(value)) == value

@pytest.mark.parametrize("value", ["a", "", None, ":b", "a:", " a:b", "a: b", "a:b ", "a#b:c", "ticket-user:host", "a:\u202eb", "a:\n", "a:\ud800", "a:"+"é"*64])
def test_reject_ambiguous_or_unsafe_selector(value):
    with pytest.raises(ValueError):
        parse_selector(value)

def test_byte_boundary():
    assert parse_selector("a:"+"é"*63)[1] == "é"*63

def test_tmux_name_is_bounded_safe_and_owner_scoped():
    import re
    a=tmux_name("x"*200, "host", 22, "user:target", 1)
    b=tmux_name("x"*200, "host", 22, "user:target", 2)
    assert re.fullmatch(r"[A-Za-z0-9_]{1,190}", a)
    assert a != b
