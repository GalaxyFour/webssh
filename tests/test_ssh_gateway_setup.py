import pytest
from app.ssh_gateway_setup import ReadyLine

def test_ready_line_requires_exact_complete_line_across_chunks():
    parser = ReadyLine(b"WEBSSH_READY_nonce")
    parser.feed(b"banner WEBSSH_READY_nonce\r\nWEBSSH_RE")
    assert not parser.ready
    parser.feed(b"ADY_nonce\r")
    assert not parser.ready
    parser.feed(b"\n")
    assert parser.ready

def test_ready_parser_bounds_unterminated_lines():
    parser = ReadyLine(b"nonce")
    with pytest.raises(ValueError):
        parser.feed(b"x"*65537)
