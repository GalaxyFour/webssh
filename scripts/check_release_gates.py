"""Fail closed unless every required release test gate completed successfully."""

import json
import os


REQUIRED = frozenset({
    'dispatch-integrity', 'dependency-locks', 'pytest', 'redis-rate-limiter',
    'ssh-integration', 'smb-integration', 'browser-e2e-shards', 'browser-e2e',
    'container-threading-smoke', 'release-contract',
})


def validate_gates(results):
    if set(results) != REQUIRED:
        raise ValueError('Release validation must include every required gate')
    unsuccessful = sorted(name for name, value in results.items()
                          if value.get('result') != 'success')
    if unsuccessful:
        raise ValueError('Required gates did not succeed: ' + ', '.join(unsuccessful))


if __name__ == '__main__':
    validate_gates(json.loads(os.environ['GATE_RESULTS']))
    print('Every required test gate succeeded for this workflow revision')
