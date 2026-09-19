"""A release cannot proceed when a required CI job is absent or not successful."""

import pytest
from scripts.check_release_gates import REQUIRED, validate_gates


def successful():
    return {name: {'result': 'success'} for name in REQUIRED}


def test_all_successful_gates_are_accepted():
    validate_gates(successful())


@pytest.mark.parametrize('result', ['failure', 'cancelled', 'skipped', '', None])
@pytest.mark.parametrize('gate', sorted(REQUIRED))
def test_every_unsuccessful_gate_blocks_release(gate, result):
    results = successful()
    results[gate]['result'] = result
    with pytest.raises(ValueError, match='did not succeed'):
        validate_gates(results)


def test_omitted_gate_is_not_treated_as_success():
    results = successful()
    results.pop('browser-e2e')
    with pytest.raises(ValueError, match='every required gate'):
        validate_gates(results)
